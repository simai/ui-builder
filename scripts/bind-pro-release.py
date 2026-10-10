#!/usr/bin/env python3
"""Bind a SIMAI Framework Pro release in ui-pro, and check it.

A Pro release is one ui-pro build commit that wrote `smart/` (the four Pro
component folders and the package rule file `smart/rule.js`). Its id is
`pro-<first 12 hex of that commit>`, and its contract is
`ui-pro/contracts/releases/pro-<12>.lock.json`, shaped like the Framework's
lock v2 (one runtime source, `smart`, named by the build commit that last
wrote it) plus `requires`: the free release (`ui-<12>`) and the ui-source
revision Pro was built and tested against.

Phases (scripts/publish-pro-release.sh runs them in this order):

  package   Before anything is committed: the Pro rules in the build output
            agree with the package reference the free release publishes
            (ui contracts/packages/pro.package.json): the same rules, tags
            and folders, and `requires` equal to each rule's relations as
            registry ids.
  receipt   After the build commit: what was built, from what, by whom.
  owners    ui-pro contracts/owners/smart-component.manifest.json, bound to
            the release. Runtime fields are derived from the release; curated
            fields (title, lifecycle, readiness, curated_for, example refs)
            are kept from the manifest already in ui-pro, else seeded from
            the free Smart owner manifest of the ui release that stopped
            shipping the component, else defaulted.
  reference The release lock pro-<12>.lock.json.
  check     The Pro release gate: every lock in ui-pro validates and agrees
            with git; with --ui-root, each lock's `requires.framework` is a
            ui release built from `requires.source`.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

BUILDER_ROOT = Path(__file__).resolve().parents[1]
OWNER = 'simai/ui-pro'
REPOSITORY = 'https://github.com/simai/ui-pro'
PACKAGE = 'pro'
TREE = 'smart'
RULE_FILE = 'smart/rule.js'
MANIFEST = 'contracts/owners/smart-component.manifest.json'
UI_SMART_MANIFEST = 'contracts/owners/smart-component.manifest.json'
PACKAGE_REFERENCE = 'contracts/packages/pro.package.json'
LOCK_SCHEMA = 'simai.framework.pro-release-lock'
LOCK_KEYS = {
    'schema_id', 'schema_version', 'compatibility_id', 'status', 'profile', 'package',
    'runtime_sources', 'required_files', 'requires', 'build_inputs', 'inventory', 'exclusions', 'claims',
}
DEFAULTS = {
    'lifecycle': 'experimental',
    'readiness': {'status': 'discoverable', 'safe_to_suggest': False, 'profiles': ['plain-assets-v1'], 'blockers': []},
}


class ReleaseError(ValueError):
    """The Pro release disagrees with itself, with git or with the free release."""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def text(root, *args):
    return git(root, *args).decode().strip()


def exists(root, revision, path):
    return subprocess.run(['git', '-C', str(root), 'cat-file', '-e', f'{revision}:{path}'], capture_output=True).returncode == 0


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def load_registry_builder(ui_root):
    """ui's own registry builder: relation ids and the owner-manifest envelope
    are the free registry's, so a Pro manifest is checked by the same code."""
    path = Path(ui_root) / 'scripts/build-framework-registry.py'
    spec = importlib.util.spec_from_file_location('framework_registry_builder_pro', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_rule_file(path):
    """The rules a generated package rule file registers (it is plain data)."""
    source = Path(path).read_text()
    match = re.fullmatch(r'(?s)(?://[^\n]*\n)*SF\.RuleLoader\.registerPackage\("([a-z][a-z0-9-]*)", \{\n  rules: (.*),\n\}\);\n', source)
    if not match or match.group(1) != PACKAGE:
        raise ReleaseError(f'{path}: not a generated "{PACKAGE}" package rule file')
    return json.loads(match.group(2))


def writer(root, revision, path):
    commit = text(root, 'log', '-1', '--format=%H', revision, '--', path)
    if not commit:
        raise ReleaseError(f'no commit in {root} has written {path}')
    return commit


def tree_entry(root, revision, path):
    return {
        'revision': revision,
        'tree': text(root, 'rev-parse', revision + '^{tree}'),
        'runtime_path': path,
        'runtime_tree': text(root, 'rev-parse', f'{revision}:{path}'),
        'archive_sha256': sha(git(root, 'archive', '--format=tar', revision, path)),
    }


def input_entry(owner, root, revision):
    return {
        'owner': owner,
        'commit': revision,
        'tree': text(root, 'rev-parse', revision + '^{tree}'),
        'archive_sha256': sha(git(root, 'archive', '--format=tar', revision)),
    }


def framework_lock(ui_root, framework):
    path = Path(ui_root) / 'contracts/releases' / f'{framework}.lock.json'
    if not re.fullmatch(r'ui-[0-9a-f]{12}', framework) or not path.is_file():
        raise ReleaseError(f'no free release {framework} in {ui_root}/contracts/releases')
    lock = json.loads(path.read_text())
    if lock.get('schema_version') != 2 or lock.get('compatibility_id') != framework:
        raise ReleaseError(f'{framework}: not a v2 Framework release lock')
    return lock


def expected_requires(rules, ui_root, revision):
    """Each Pro rule's relations as registry ids: a Pro rule by the package's
    id for it, any other by the free registry's mapping over the release's
    rule.json."""
    builder = load_registry_builder(ui_root)
    reference = json.loads(git(ui_root, 'show', f'{revision}:{PACKAGE_REFERENCE}'))
    pro_ids = {item['rule_name']: item['id'] for item in reference['provides']}
    free_rules = json.loads(git(ui_root, 'show', f'{revision}:distr/rule/rule.json'))
    kinds = {rule['name']: rule.get('type', 'utility') for rule in free_rules}
    requires = {}
    for name, rule in rules.items():
        ids = set()
        for relation in rule.get('relation', []):
            ids.add(pro_ids[relation['name']] if relation['name'] in pro_ids else builder.relation_id(relation['name'], kinds))
        requires[name] = sorted(ids)
    return reference, requires


def check_package(ui_root, framework, smart_root):
    """The Pro rules agree with the package reference of the free release."""
    lock = framework_lock(ui_root, framework)
    release = lock['runtime_sources']['core']['revision']
    # The reference is read where the release's own lock is: the bind commit
    # that wrote it (the build commit itself does not carry contracts yet).
    bind = writer(ui_root, 'HEAD', f'contracts/releases/{framework}.lock.json')
    rules = read_rule_file(Path(smart_root) / 'rule.js')
    reference, requires = expected_requires(rules, ui_root, bind)
    problems = []
    declared = {item['rule_name']: item for item in reference['provides']}
    if set(declared) != set(rules):
        problems.append(f'rules {sorted(rules)} but the package reference names {sorted(declared)}')
    for name, item in declared.items():
        rule = rules.get(name)
        if rule is None:
            continue
        if rule.get('tags') != [item['element']]:
            problems.append(f'{name}: tags {rule.get("tags")}, the reference says {item["element"]}')
        if not (Path(smart_root) / item['folder']).is_dir():
            problems.append(f'{name}: no folder {item["folder"]} in the build output')
        if exists(ui_root, release, f'distr/smart/{item["folder"]}'):
            problems.append(f'{name}: the free release {framework} still ships distr/smart/{item["folder"]}')
        if requires[name] != item['requires']:
            problems.append(f'{name}: relations {requires[name]}, the reference requires {item["requires"]}')
    if problems:
        raise ReleaseError('the Pro rules and ui ' + PACKAGE_REFERENCE + ' at ' + framework + ' disagree:\n  ' + '\n  '.join(problems))
    print(json.dumps({'package': PACKAGE, 'framework': framework, 'rules': sorted(rules), 'agrees': True}))


def files_under(root, current=None):
    """In the order verify-pro-reproducibility.cjs hashes: each directory's
    entries by name, a directory expanded where it falls."""
    current = current or root
    found = []
    for path in sorted(Path(current).iterdir(), key=lambda item: item.name):
        if path.is_dir():
            found.extend(files_under(root, path))
        else:
            data = path.read_bytes()
            found.append({'path': path.relative_to(root).as_posix(), 'sha256': sha(data), 'size': len(data)})
    return found


def check_output(report_path):
    """The build output is the passing, byte-identical one the report hashed."""
    report = json.loads(Path(report_path).read_text())
    pro = (report.get('products') or {}).get('pro') or {}
    if report.get('status') != 'PASS' or not pro.get('byte_identical'):
        raise ReleaseError('the reproducibility report did not pass')
    output = Path(report_path).parent / 'wave-1/output/pro'
    files = files_under(output)
    if sha((json.dumps(files, separators=(',', ':')) + '\n').encode()) != pro['manifest_sha256']:
        raise ReleaseError(f'{output} is not the output the report hashed')
    print(report['pro_revision'], report['source_revision'])


def receipt(args):
    release = text(args.pro_root, 'rev-parse', '--verify', writer(args.pro_root, 'HEAD', TREE) + '^{commit}')
    report = json.loads(Path(args.report).read_text())
    lock = framework_lock(args.ui_root, args.framework)
    if report['source_revision'] != lock['build_inputs']['source']['commit']:
        raise ReleaseError(f'Pro was built over ui-source {report["source_revision"][:12]}, {args.framework} from {lock["build_inputs"]["source"]["commit"][:12]}')
    value = {
        'schema': 'simai.framework.pro_release_receipt.v1',
        'release_revision': release,
        'runtime_sources': {'smart': tree_entry(args.pro_root, writer(args.pro_root, release, TREE), TREE)},
        'pro_source_revision': report['pro_revision'],
        'source_revision': report['source_revision'],
        'builder_revision': text(BUILDER_ROOT, 'rev-parse', '--verify', (args.builder_revision or 'HEAD') + '^{commit}'),
        'framework': args.framework,
        'build_manifest_sha256': report['products']['pro']['manifest_sha256'],
    }
    write(Path(args.output), value)
    print(json.dumps({'release': release[:12], 'pro_source': value['pro_source_revision'][:12], 'source': value['source_revision'][:12], 'framework': args.framework}))


def asset_paths(root, revision, folder):
    names = text(root, 'ls-tree', '-r', '--name-only', revision, f'{TREE}/{folder}').splitlines()
    return [f'{OWNER}@{revision}:{name}' for name in sorted(names)
            if name.split('/')[2] in ('css', 'js', 'template') and not name.endswith('.gz')]


def owners(args):
    value = json.loads(Path(args.receipt).read_text())
    release = value['release_revision']
    smart = value['runtime_sources']['smart']
    revision = smart['revision']
    rules = read_rule_file(Path(args.pro_root) / RULE_FILE)
    lock = framework_lock(args.ui_root, value['framework'])
    bind = writer(args.ui_root, 'HEAD', f'contracts/releases/{value["framework"]}.lock.json')
    reference, requires = expected_requires(rules, args.ui_root, bind)
    by_rule = {item['rule_name']: item for item in reference['provides']}
    path = Path(args.pro_root) / MANIFEST
    current = json.loads(path.read_text()) if path.is_file() else None
    kept = {entry['id']: entry for entry in (current or {}).get('entries', [])}
    # The free Smart owner manifest at the free release's build commit still
    # holds the entries the bind of that release retired.
    seed = json.loads(git(args.ui_root, 'show', f'{lock["runtime_sources"]["core"]["revision"]}:{UI_SMART_MANIFEST}'))
    seeded = {entry['id']: entry for entry in seed['entries']}
    entries = []
    for name in sorted(rules, key=lambda rule: by_rule[rule]['id']):
        item = by_rule[name]
        rule = rules[name]
        source = json.loads(git(args.pro_root, 'show', f'{revision}:{TREE}/{item["folder"]}/smart.manifest.json'))
        curated = kept.get(item['id']) or seeded.get(item['id']) or {}
        entries.append({
            'id': item['id'],
            'kind': 'smart-component',
            'name': item['folder'],
            'title': curated.get('title') or source['title'],
            'owner': OWNER,
            'lifecycle': curated.get('lifecycle') or source.get('lifecycle') or DEFAULTS['lifecycle'],
            'readiness': curated.get('readiness') or DEFAULTS['readiness'],
            'provenance': {
                'repository': REPOSITORY,
                'tag': None,
                'commit': revision,
                'source_refs': [f'{OWNER}@{revision}:{TREE}/{item["folder"]}', f'{OWNER}@{revision}:{RULE_FILE}#name={name}'],
            },
            'documentation_refs': [f'{OWNER}@{release}:README.md'],
            'example_refs': [ref for ref in curated.get('example_refs', []) if ref.startswith(OWNER + '@')],
            'runtime': {
                'rule_name': name,
                'tags': rule['tags'],
                'asset_paths': asset_paths(args.pro_root, revision, item['folder']),
                'declared': {'js': bool(rule.get('js', False)), 'css': bool(rule.get('css', False))},
            },
            'requires': requires[name],
            'curated_for': curated.get('curated_for', []),
        })
    manifest = {
        'schema_id': 'simai.framework.owner-manifest',
        'schema_version': 1,
        'kind': 'smart-component',
        'owner': {'id': OWNER, 'repository': REPOSITORY, 'manifest_path': MANIFEST},
        'release': {'tag': None, 'commit': revision, 'tree': smart['tree'], 'runtime_subtree': smart['runtime_tree'], 'archive_sha256': smart['archive_sha256']},
        'inventory': {'source': f'{OWNER}@{revision}:{TREE}', 'selector': '*/js/*.js', 'expected': len(entries)},
        'defaults': (current or {}).get('defaults') or {'lifecycle': 'released', 'readiness': DEFAULTS['readiness']},
        'entries': entries,
    }
    load_registry_builder(args.ui_root).validate_manifest_envelope(manifest, 'smart-component')
    for entry in entries:
        for ref in entry['runtime']['asset_paths']:
            found, relative = ref.split('@', 1)[1].split(':', 1)
            git(args.pro_root, 'cat-file', '-e', f'{found}:{relative}')
    write(path, manifest)
    print('Pro owner manifest bound: ' + ', '.join(entry['id'] for entry in entries))


def required_files(rules, by_rule):
    files = [RULE_FILE]
    for name, rule in sorted(rules.items()):
        folder = by_rule[name]['folder']
        if rule.get('js'):
            files.append(f'{TREE}/{folder}/js/{folder}.js')
        if rule.get('css'):
            files.append(f'{TREE}/{folder}/css/{folder}.css')
    return files


def reference_phase(args):
    value = json.loads(Path(args.receipt).read_text())
    release = value['release_revision']
    smart = value['runtime_sources']['smart']
    manifest = json.loads((Path(args.pro_root) / MANIFEST).read_text())
    if manifest['release']['commit'] != smart['revision']:
        raise ReleaseError('bind the owner manifest (phase owners) before the reference phase')
    rules = read_rule_file(Path(args.pro_root) / RULE_FILE)
    by_rule = {entry['runtime']['rule_name']: {'folder': entry['name']} for entry in manifest['entries']}
    compatibility = 'pro-' + release[:12]
    lock = {
        'schema_id': LOCK_SCHEMA,
        'schema_version': 1,
        'compatibility_id': compatibility,
        'status': 'bounded',
        'profile': 'plain-assets-v1',
        'package': PACKAGE,
        'runtime_sources': {
            'smart': {
                'owner': OWNER, 'tag': None, 'tag_object': None, 'revision': release,
                'commit': smart['revision'], 'tree': smart['tree'], 'runtime_path': TREE,
                'runtime_tree': smart['runtime_tree'], 'archive_sha256': smart['archive_sha256'],
            },
        },
        'required_files': required_files(rules, by_rule),
        'requires': {'framework': value['framework'], 'source': value['source_revision']},
        'build_inputs': {
            'source': input_entry('simai/ui-source', args.source_root, value['source_revision']),
            'pro_source': input_entry('simai/ui-source-pro', args.pro_source_root, value['pro_source_revision']),
            'builder': input_entry('simai/ui-builder', BUILDER_ROOT, value['builder_revision']),
        },
        'inventory': {'smart_components': len(manifest['entries']), 'rules': len(rules)},
        'exclusions': [],
        'claims': {'full_compatible': False, 'production_ready': False, 'all_items_ready': False},
    }
    validate_lock(lock)
    write(Path(args.pro_root) / 'contracts/releases' / f'{compatibility}.lock.json', lock)
    print(json.dumps({'compatibility_id': compatibility, 'requires': lock['requires']}))


def validate_lock(lock):
    if set(lock) != LOCK_KEYS or lock['schema_id'] != LOCK_SCHEMA or lock['schema_version'] != 1:
        raise ReleaseError(f'{lock.get("compatibility_id")}: not a Pro release lock v1')
    if not re.fullmatch(r'pro-[0-9a-f]{12}', lock['compatibility_id']) or lock['package'] != PACKAGE:
        raise ReleaseError(f'{lock["compatibility_id"]}: id or package')
    if set(lock['runtime_sources']) != {'smart'}:
        raise ReleaseError(f'{lock["compatibility_id"]}: one runtime source, smart')
    smart = lock['runtime_sources']['smart']
    if smart['owner'] != OWNER or smart['runtime_path'] != TREE or lock['compatibility_id'] != 'pro-' + smart['revision'][:12]:
        raise ReleaseError(f'{lock["compatibility_id"]}: the smart source is not ui-pro smart at the release')
    if not re.fullmatch(r'ui-[0-9a-f]{12}', lock['requires'].get('framework', '')) or not re.fullmatch(r'[0-9a-f]{40}', lock['requires'].get('source', '')) or set(lock['requires']) != {'framework', 'source'}:
        raise ReleaseError(f'{lock["compatibility_id"]}: requires names the free release and the ui-source revision')
    if lock['build_inputs']['source']['commit'] != lock['requires']['source']:
        raise ReleaseError(f'{lock["compatibility_id"]}: built over a ui-source revision it does not require')
    if RULE_FILE not in lock['required_files']:
        raise ReleaseError(f'{lock["compatibility_id"]}: the package rule file is a required file')


def check(args):
    """The Pro release gate."""
    directory = Path(args.pro_root) / 'contracts/releases'
    locks = sorted(directory.glob('pro-*.lock.json')) if directory.is_dir() else []
    if not locks:
        raise ReleaseError('no Pro release lock in ' + str(directory))
    for path in locks:
        lock = json.loads(path.read_text())
        validate_lock(lock)
        if path.name != lock['compatibility_id'] + '.lock.json':
            raise ReleaseError(f'{path.name}: named after another id')
        smart = lock['runtime_sources']['smart']
        release = smart['revision']
        if writer(args.pro_root, release, TREE) != smart['commit']:
            raise ReleaseError(f'{path.name}: smart was last written by another commit')
        if writer(args.pro_root, release, TREE) != release:
            raise ReleaseError(f'{path.name}: the release commit did not write smart')
        live = tree_entry(args.pro_root, smart['commit'], TREE)
        for key in ('tree', 'runtime_tree', 'archive_sha256'):
            if live[key] != smart[key]:
                raise ReleaseError(f'{path.name}: {key} disagrees with git')
        for name in lock['required_files']:
            if not exists(args.pro_root, release, name):
                raise ReleaseError(f'{path.name}: required file {name} is not in the release')
        if args.ui_root:
            framework = framework_lock(args.ui_root, lock['requires']['framework'])
            if framework['build_inputs']['source']['commit'] != lock['requires']['source']:
                raise ReleaseError(f'{path.name}: {lock["requires"]["framework"]} was not built from the ui-source revision it requires')
    manifest = json.loads((Path(args.pro_root) / MANIFEST).read_text())
    newest = max(locks, key=lambda item: int(text(args.pro_root, 'log', '-1', '--format=%ct', json.loads(item.read_text())['runtime_sources']['smart']['revision'])))
    newest_lock = json.loads(newest.read_text())
    if manifest['release']['commit'] != newest_lock['runtime_sources']['smart']['commit']:
        raise ReleaseError('the owner manifest is not bound to the newest release')
    if manifest['inventory']['expected'] != len(manifest['entries']) or manifest['inventory']['expected'] != newest_lock['inventory']['smart_components']:
        raise ReleaseError('the owner manifest inventory disagrees with its entries or the lock')
    for entry in manifest['entries']:
        for ref in entry['runtime']['asset_paths']:
            found, relative = ref.split('@', 1)[1].split(':', 1)
            if not exists(args.pro_root, found, relative):
                raise ReleaseError(f'{entry["id"]}: asset {relative} is not at {found[:12]}')
    print(json.dumps({'locks': [path.name for path in locks], 'newest': newest.name, 'gate': 'clean'}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['output', 'package', 'receipt', 'owners', 'reference', 'check'])
    parser.add_argument('--pro-root', type=Path)
    parser.add_argument('--ui-root', type=Path)
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--pro-source-root', type=Path)
    parser.add_argument('--framework')
    parser.add_argument('--smart-root', type=Path, help='package phase: the smart/ of the build output')
    parser.add_argument('--report', type=Path, help='output and receipt phases: report.json of verify-pro-reproducibility.cjs')
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--builder-revision')
    args = parser.parse_args()
    try:
        if args.phase == 'output':
            check_output(args.report)
        elif args.phase == 'package':
            check_package(args.ui_root, args.framework, args.smart_root)
        elif args.phase == 'receipt':
            receipt(args)
        elif args.phase == 'owners':
            owners(args)
        elif args.phase == 'reference':
            reference_phase(args)
        else:
            check(args)
    except ReleaseError as error:
        print('PRO_RELEASE_ERROR — ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
