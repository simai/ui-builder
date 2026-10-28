#!/usr/bin/env python3
"""Write the receipt of a product component package build.

A product package (docs/developer/product-packages.md) is not released into a
distribution repository: the product's own build runs ui-builder and keeps the
output. What a consumer pins is this receipt, `package-receipt.json`
(schema `simai.framework.product-package-receipt` v1): what was built (the
package name, its source repository, revision and path), over what (the
ui-source revision, and the free release `ui-<12>` built from it when a `ui`
checkout is given), by what (the ui-builder revision), and the output's hashes
(every file, a manifest digest, and a deterministic tar archive written beside
the receipt), its required files and its element and rule inventory, and under
what licence: `licence.ref`, the `license` of the package folder's
`package.json` at the built revision (an SPDX id, a `LicenseRef-...` or an SPDX
expression). A package without a declared licence gets no receipt.

With `--ui`, the package is also checked against the free release:

- every relation of a package rule names a rule of the package or of the
  release (`distr/rule/rule.json`), and no package element is a free one;
- when the release publishes a package reference for this name
  (`distr/core/contracts/packages/<name>.package.json`), it must agree with the
  package rules: the same rules, elements and folders, none of the folders in
  the release's `distr/smart`, and each entry's `requires` equal to its rule's
  relations as registry ids. A missing reference is a warning, not a failure.

Usage:
  write-package-receipt.py --report WORKSPACE/report.json [--ui UI]
      [--output FILE] [--archive FILE]
"""
import argparse
import hashlib
import importlib.util
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

SCHEMA_ID = 'simai.framework.product-package-receipt'
SCHEMA_VERSION = 1
RUNTIME_PATH = 'smart'
RULE_FILE = 'smart/rule.js'
RULE_FILE_PATTERN = re.compile(r'(?s)(?://[^\n]*\n)*SF\.RuleLoader\.registerPackage\("([a-z][a-z0-9-]*)", \{\n  rules: (.*),\n\}\);\n')
RELEASE_LOCK = re.compile(r'ui-[0-9a-f]{12}\.lock\.json')
# An SPDX license expression: ids (`Apache-2.0`, `LicenseRef-SIMAI-Commercial`,
# `GPL-2.0-or-later`, `MIT+`), AND / OR / WITH, parentheses. npm's
# `UNLICENSED` and `SEE LICENSE IN <file>` name no licence and are refused.
LICENCE_TOKEN = re.compile(r'\(|\)|[A-Za-z0-9][A-Za-z0-9.\-]*\+?')
LICENCE_OPERATORS = {'AND', 'OR', 'WITH'}


class ReceiptError(ValueError):
    """The build output, the report and the free release disagree."""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def text(root, *args):
    return git(root, *args).decode().strip()


def exists(root, revision, path):
    return subprocess.run(['git', '-C', str(root), 'cat-file', '-e', f'{revision}:{path}'], capture_output=True).returncode == 0


def warn(message):
    print('PACKAGE_RECEIPT_WARNING — ' + message, file=sys.stderr)


def files_under(root, current=None):
    """In the order verify-package-reproducibility.cjs hashes: each
    directory's entries by name, a directory expanded where it falls."""
    current = current or root
    found = []
    for path in sorted(Path(current).iterdir(), key=lambda item: item.name):
        if path.is_symlink():
            raise ReceiptError(f'output symlink is forbidden: {path}')
        if path.is_dir():
            found.extend(files_under(root, path))
        else:
            data = path.read_bytes()
            found.append({'path': path.relative_to(root).as_posix(), 'sha256': sha(data), 'size': len(data)})
    return found


def read_rule_file(path):
    match = RULE_FILE_PATTERN.fullmatch(Path(path).read_text())
    if not match:
        raise ReceiptError(f'{path}: not a generated package rule file')
    return match.group(1), json.loads(match.group(2))


def deterministic_tar(root, files):
    """A plain ustar archive of the output: entries sorted, directories before
    their files, owner 0:0 with empty names, mtime 0, modes 0755 and 0644. The
    same files always give the same bytes."""
    buffer = io.BytesIO()
    directories = sorted({'/'.join(item['path'].split('/')[:depth]) for item in files for depth in range(1, item['path'].count('/') + 1)})
    entries = sorted([(name, True) for name in directories] + [(item['path'], False) for item in files])
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, is_directory in entries:
            info = tarfile.TarInfo(name)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            if is_directory:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                archive.addfile(info)
            else:
                data = (Path(root) / name).read_bytes()
                info.mode = 0o644
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def load_registry_builder(ui_root):
    """ui's own registry builder: relation ids are the free registry's."""
    path = Path(ui_root) / 'scripts/build-framework-registry.py'
    spec = importlib.util.spec_from_file_location('framework_registry_builder_package', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def writer(root, revision, path):
    commit = text(root, 'log', '-1', '--format=%H', revision, '--', path)
    if not commit:
        raise ReceiptError(f'no commit in {root} has written {path}')
    return commit


def resolve_release(ui_root, source_revision):
    """The free release built from the ui-source revision the package pins:
    the v2 lock in ui/contracts/releases whose build_inputs name it. Several
    (a rebuild of the same source): the newest build commit wins."""
    found = []
    for path in sorted((Path(ui_root) / 'contracts/releases').iterdir()):
        if not RELEASE_LOCK.fullmatch(path.name):
            continue
        lock = json.loads(path.read_text())
        if lock.get('schema_version') == 2 and lock['build_inputs']['source']['commit'] == source_revision:
            found.append(lock)
    if not found:
        return None, []
    found.sort(key=lambda lock: int(text(ui_root, 'log', '-1', '--format=%ct', lock['runtime_sources']['core']['revision'])))
    return found[-1], [lock['compatibility_id'] for lock in found]


def check_against_release(ui_root, release_lock, name, rules, folders, output_root):
    framework = release_lock['compatibility_id']
    release = release_lock['runtime_sources']['core']['revision']
    # Contracts are read where the release's own lock is: the bind commit that
    # wrote it (the build commit does not carry the bound contracts yet).
    bind = writer(ui_root, 'HEAD', f'contracts/releases/{framework}.lock.json')
    free_rules = json.loads(git(ui_root, 'show', f'{release}:distr/rule/rule.json'))
    free_names = {rule['name'] for rule in free_rules}
    free_tags = {tag for rule in free_rules for tag in rule.get('tags', [])}
    problems = []
    for rule_name, rule in rules.items():
        for relation in rule.get('relation', []):
            if relation['name'] not in rules and relation['name'] not in free_names:
                problems.append(f'{rule_name}: relation {relation["name"]} is neither a package rule nor a rule of {framework}')
        for tag in rule['tags']:
            if tag in free_tags:
                problems.append(f'{rule_name}: <{tag}> is also an element of the free release {framework}')
    if problems:
        raise ReceiptError(f'the package and the free release {framework} disagree:\n  ' + '\n  '.join(problems))

    reference_path = f'distr/core/contracts/packages/{name}.package.json'
    result = {'path': reference_path, 'release': framework}
    if not exists(ui_root, bind, reference_path):
        warn(f'{framework} publishes no package reference {reference_path}; the rules are not checked against one')
        return {**result, 'status': 'absent'}

    builder = load_registry_builder(ui_root)
    reference = json.loads(git(ui_root, 'show', f'{bind}:{reference_path}'))
    package_ids = {item['rule_name']: item['id'] for item in reference['provides']}
    kinds = {rule['name']: rule.get('type', 'utility') for rule in free_rules}
    declared = {item['rule_name']: item for item in reference['provides']}
    if reference.get('package') != name:
        problems.append(f'the reference names package {reference.get("package")}')
    if set(declared) != set(rules):
        problems.append(f'rules {sorted(rules)} but the reference names {sorted(declared)}')
    for rule_name, item in declared.items():
        rule = rules.get(rule_name)
        if rule is None:
            continue
        if rule.get('tags') != [item['element']]:
            problems.append(f'{rule_name}: tags {rule.get("tags")}, the reference says {item["element"]}')
        if item['folder'] not in folders or not (Path(output_root) / RUNTIME_PATH / item['folder']).is_dir():
            problems.append(f'{rule_name}: no folder {item["folder"]} in the build output')
        if exists(ui_root, release, f'distr/smart/{item["folder"]}'):
            problems.append(f'{rule_name}: the free release {framework} still ships distr/smart/{item["folder"]}')
        requires = sorted({
            package_ids[relation['name']] if relation['name'] in package_ids else builder.relation_id(relation['name'], kinds)
            for relation in rule.get('relation', [])
        })
        if requires != item['requires']:
            problems.append(f'{rule_name}: relations {requires}, the reference requires {item["requires"]}')
    if problems:
        raise ReceiptError(f'the package rules and ui {reference_path} at {framework} disagree:\n  ' + '\n  '.join(problems))
    return {**result, 'status': 'agrees'}


RUNTIME_CONTRACT = 'distr/core/contracts/shared-runtime.v1.json'


def check_runtime_against_release(ui_root, release_lock, runtime):
    """The shared runtime modules the package asks for, against the release's.

    A package carries no element layer of its own: its bundles ask the page's
    runtime (SF.runtimeModule) for lit, smart-base, element-manifest and the
    rest, with the runtime ABI of the ui-source they were built over. The page
    runs the release's runtime, so the release must have the same ABI, every
    module the package asks for and every name it imports from one.
    """
    framework = release_lock['compatibility_id']
    release = release_lock['runtime_sources']['core']['revision']
    used = (runtime or {}).get('modules') or {}
    if not exists(ui_root, release, RUNTIME_CONTRACT):
        if (runtime or {}).get('abi') is not None:
            raise ReceiptError(f'the package was built for runtime ABI {runtime["abi"]}; {framework} publishes no {RUNTIME_CONTRACT}')
        return {'contract': None, 'status': 'not-published'}
    contract = json.loads(git(ui_root, 'show', f'{release}:{RUNTIME_CONTRACT}'))
    problems = []
    if runtime is None:
        problems.append('the build reported no shared runtime usage (a builder from before 2026-10-28)')
    elif runtime.get('abi') != contract['abi']:
        problems.append(f'built for runtime ABI {runtime.get("abi")}, {framework} runs ABI {contract["abi"]}')
    for module_id, names in sorted(used.items()):
        offered = contract['modules'].get(module_id)
        if offered is None:
            problems.append(f'asks for the shared module {module_id}, which {framework} does not hand out')
            continue
        exports = offered.get('exports')
        if exports is None:
            continue
        missing = [name for name in names if name != '*' and name not in exports]
        if missing:
            problems.append(f'{module_id}: imports {", ".join(missing)}, which {framework} does not export')
    if problems:
        raise ReceiptError(f'the package and the runtime of {framework} disagree:\n  ' + '\n  '.join(problems))
    return {'contract': RUNTIME_CONTRACT, 'status': 'agrees'}


def is_licence_expression(value):
    tokens = value.replace('(', ' ( ').replace(')', ' ) ').split()
    if not tokens or any(not LICENCE_TOKEN.fullmatch(token) for token in tokens):
        return False
    depth, expect_id = 0, True
    for token in tokens:
        if token == '(':
            if not expect_id:
                return False
            depth += 1
        elif token == ')':
            if expect_id or depth == 0:
                return False
            depth -= 1
        elif token in LICENCE_OPERATORS:
            if expect_id:
                return False
            expect_id = True
        else:
            if not expect_id or token.upper() in LICENCE_OPERATORS or token == 'UNLICENSED':
                return False
            expect_id = False
    return depth == 0 and not expect_id


def read_licence(root, revision, folder):
    """The licence the package declares: `license` of the package folder's
    package.json at the built revision."""
    path = f'{folder}/package.json' if folder else 'package.json'
    where = f'{path} of {revision[:12]}'
    if not exists(root, revision, path):
        raise ReceiptError(f'{where} does not exist: a package must declare its licence in its package.json "license"')
    try:
        manifest = json.loads(git(root, 'show', f'{revision}:{path}'))
    except json.JSONDecodeError as error:
        raise ReceiptError(f'{where} is not JSON: {error}') from None
    licence = manifest.get('license') if isinstance(manifest, dict) else None
    if licence is None:
        raise ReceiptError(f'{where} declares no "license": a package must declare its licence (an SPDX id, a LicenseRef-... or an SPDX expression)')
    if not isinstance(licence, str) or not is_licence_expression(licence.strip()):
        raise ReceiptError(f'{where}: "license" {json.dumps(licence)} is not an SPDX id, a LicenseRef-... or an SPDX expression')
    return {'ref': licence.strip()}


def required_files(rules):
    files = [RULE_FILE]
    for rule_name, rule in sorted(rules.items()):
        folder = rule_name[3:]
        if rule.get('js'):
            files.append(f'{RUNTIME_PATH}/{folder}/js/{folder}.js')
        if rule.get('css'):
            files.append(f'{RUNTIME_PATH}/{folder}/css/{folder}.css')
    return files


def build_receipt(args):
    report_path = Path(args.report).resolve()
    workspace = report_path.parent
    report = json.loads(report_path.read_text())
    product = (report.get('products') or {}).get('package') or {}
    if report.get('product') != 'package' or report.get('status') != 'PASS' or not product.get('byte_identical'):
        raise ReceiptError('the reproducibility report is not a passing, byte-identical package build')
    name = report['package']
    output_root = workspace / report['output']
    files = files_under(output_root)
    if sha((json.dumps(files, separators=(',', ':')) + '\n').encode()) != product['manifest_sha256']:
        raise ReceiptError(f'{output_root} is not the output the report hashed')

    registered, rules = read_rule_file(output_root / RULE_FILE)
    folders = report['components']
    if registered != name:
        raise ReceiptError(f'{RULE_FILE} registers package {registered}, the build was {name}')
    if sorted(rules) != sorted(f'cl-{folder}' for folder in folders):
        raise ReceiptError(f'{RULE_FILE} registers {sorted(rules)}, the package holds {folders}')
    required = required_files(rules)
    present = {item['path'] for item in files}
    missing = [path for path in required if path not in present]
    if missing:
        raise ReceiptError('required files are not in the output: ' + ', '.join(missing))

    source = report['package_source']
    licence = read_licence(source['root'], source['revision'], source['path'])

    archive = deterministic_tar(output_root, files)
    archive_path = Path(args.archive) if args.archive else workspace / f'package-{name}.tar'
    archive_path.write_bytes(archive)

    treeish = f'{source["revision"]}:{source["path"]}' if source['path'] else source['revision'] + '^{tree}'
    framework = {'source': {'repository': 'simai/ui-source', 'revision': report['source_revision']}, 'release': None}
    # What the package's bundles ask the page's shared runtime for: its ABI, and
    # the modules and names (docs/developer/product-packages.md).
    runtime = report.get('runtime')
    framework['runtime'] = None if runtime is None else {'abi': runtime.get('abi'), 'modules': runtime.get('modules') or {}}
    reference = {'path': f'distr/core/contracts/packages/{name}.package.json', 'release': None, 'status': 'not-checked'}
    if args.ui:
        release_lock, candidates = resolve_release(args.ui, report['source_revision'])
        if release_lock is None:
            warn(f'no free release in {args.ui}/contracts/releases was built from ui-source {report["source_revision"][:12]}')
            reference['status'] = 'no-release'
        else:
            framework['release'] = release_lock['compatibility_id']
            if len(candidates) > 1:
                framework['release_candidates'] = candidates
            reference = check_against_release(args.ui, release_lock, name, rules, folders, output_root)
            framework['runtime_check'] = check_runtime_against_release(args.ui, release_lock, report.get('runtime'))

    by_path = {item['path']: item for item in files}
    receipt = {
        'schema_id': SCHEMA_ID,
        'schema_version': SCHEMA_VERSION,
        'package': name,
        'loader': {
            'declaration': f'SF_BOOT_CONFIG.packages.{name}.base',
            'base': f'<mount>/{RUNTIME_PATH}',
            'rule_file': RULE_FILE,
        },
        'package_source': {
            'repository': source['repository'],
            'revision': source['revision'],
            'path': source['path'],
            'tree': text(source['root'], 'rev-parse', '--verify', treeish),
        },
        'licence': licence,
        'framework': framework,
        'builder': {
            'repository': 'simai/ui-builder',
            'revision': report['builder']['revision'],
            'clean': report['builder']['clean'],
        },
        'node': report['node'],
        'output': {
            'runtime_path': RUNTIME_PATH,
            'files_count': len(files),
            'manifest_sha256': product['manifest_sha256'],
            'archive': archive_path.name,
            'archive_sha256': sha(archive),
            'archive_format': 'ustar; entries sorted; owner 0:0; mtime 0; modes 0755/0644',
        },
        'required_files': [{'path': path, 'sha256': by_path[path]['sha256'], 'size': by_path[path]['size']} for path in required],
        'inventory': {
            'components': len(folders),
            'rules': len(rules),
            'elements': [
                {
                    'element': tag,
                    'rule_name': rule_name,
                    'folder': rule_name[3:],
                    'js': bool(rule.get('js', False)),
                    'css': bool(rule.get('css', False)),
                    'relations': [relation['name'] for relation in rule.get('relation', [])],
                }
                for rule_name, rule in sorted(rules.items())
                for tag in rule['tags']
            ],
        },
        'package_reference': reference,
        'files': files,
        'claims': {'production_ready': False},
    }
    output = Path(args.output) if args.output else workspace / 'package-receipt.json'
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({
        'receipt': str(output),
        'package': name,
        'framework': framework['release'],
        'source': report['source_revision'][:12],
        'package_reference': reference['status'],
        'archive_sha256': receipt['output']['archive_sha256'],
    }))


def main():
    parser = argparse.ArgumentParser(description='Write package-receipt.json for a product package build.')
    parser.add_argument('--report', type=Path, required=True, help='report.json of verify-package-reproducibility.cjs')
    parser.add_argument('--ui', type=Path, help='a ui checkout: resolve the free release and check the package against it')
    parser.add_argument('--output', type=Path, help='default: package-receipt.json beside the report')
    parser.add_argument('--archive', type=Path, help='default: package-<name>.tar beside the report')
    args = parser.parse_args()
    try:
        build_receipt(args)
    except ReceiptError as error:
        print('PACKAGE_RECEIPT_ERROR — ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
