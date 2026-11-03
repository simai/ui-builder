#!/usr/bin/env python3
"""Bind a component set release kept in git, and check it.

The generic release bind (standard simai.component-set, one-release-route): a
set whose built output is kept in its own repository -- the set `effects` in
simai/ui-effects, `package/dist/` -- is released by one Build commit that lays
the verified build output there, and one bind commit that writes the release
lock `contracts/releases/<set>-<12>.lock.json` (schema
`simai.framework.package-release-lock` v1). The id is `<set>-<first 12 hex of
the set commit the build was made from>`: the same id the release tag, the npm
version's row in the compatibility index and the stamped passport carry.

Owner and package come from the build itself (its report and receipt, whose
package source names the repository and folder), never from constants: the
same script binds any set. scripts/publish-package-release.sh runs the phases
in order; scripts/bind-pro-release.py keeps the older Pro route and reuses the
helpers below.

Phases:

  output    Before anything is committed: the build output is the passing,
            byte-identical one the reproducibility report hashed. Prints the
            package revision and the ui-source revision.
  lock      After the Build commit: the release lock, and the passport stamped
            with its release block (written to --set-out, a release asset; the
            set.json in the repository stays the bytes the receipt hashed).
  check     The release gate: every lock validates and agrees with git, and
            the output in the repository at each Build commit is, byte for
            byte, what its receipt lists.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

BUILDER_ROOT = Path(__file__).resolve().parents[1]
LOCK_SCHEMA = 'simai.framework.package-release-lock'
LOCK_KEYS = {
    'schema', 'schema_version', 'id', 'package', 'version', 'source', 'build', 'receipt', 'output',
    'requires', 'requires_sets', 'builder', 'claims',
}
RULE_FILE_PATTERN = re.compile(r'(?s)(?://[^\n]*\n)*SF\.RuleLoader\.registerPackage\("([a-z][a-z0-9-]*)", \{\n(?:  api: "(cl-[a-z][a-z0-9-]*)",\n)?  rules: (.*),\n\}\);\n')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?')


class ReleaseError(ValueError):
    """The release disagrees with itself, with git or with its build."""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def text(root, *args):
    return git(root, *args).decode().strip()


def exists(root, revision, path):
    return subprocess.run(['git', '-C', str(root), 'cat-file', '-e', f'{revision}:{path}'], capture_output=True).returncode == 0


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def writer(root, revision, path):
    commit = text(root, 'log', '-1', '--format=%H', revision, '--', path)
    if not commit:
        raise ReleaseError(f'no commit in {root} has written {path}')
    return commit


def read_rule_file(path, package=None):
    """The package name, api rule and rules of a generated package rule file."""
    match = RULE_FILE_PATTERN.fullmatch(Path(path).read_text())
    if not match or (package is not None and match.group(1) != package):
        raise ReleaseError(f'{path}: not a generated "{package or "package"}" package rule file')
    return match.group(1), match.group(2), json.loads(match.group(3))


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


def files_under(root, current=None):
    """In the order the reproducibility scripts hash: each directory's entries
    by name, a directory expanded where it falls."""
    current = Path(current or root)
    found = []
    for path in sorted(current.iterdir(), key=lambda item: item.name):
        if path.is_dir():
            found.extend(files_under(root, path))
        else:
            data = path.read_bytes()
            found.append({'path': path.relative_to(root).as_posix(), 'sha256': sha(data), 'size': len(data)})
    return found


def manifest_sha(files):
    return sha((json.dumps(files, separators=(',', ':')) + '\n').encode())


def check_output(report_path, product='package'):
    """The build output is the passing, byte-identical one the report hashed.
    Answers (report, output directory)."""
    report = json.loads(Path(report_path).read_text())
    built = (report.get('products') or {}).get(product) or {}
    if report.get('status') != 'PASS' or not built.get('byte_identical'):
        raise ReleaseError('the reproducibility report did not pass')
    output = Path(report_path).parent / report['output'] if product == 'package' else Path(report_path).parent / f'wave-1/output/{product}'
    if manifest_sha(files_under(output)) != built['manifest_sha256']:
        raise ReleaseError(f'{output} is not the output the report hashed')
    return report, output


def output_phase(args):
    report, _ = check_output(args.report)
    print(report['package'], report['package_source']['revision'], report['source_revision'])


def lock_phase(args):
    report, _ = check_output(args.report)
    receipt_bytes = Path(args.receipt).read_bytes()
    receipt = json.loads(receipt_bytes)
    name = report['package']
    source = report['package_source']
    if receipt.get('package') != name or receipt['package_source']['revision'] != source['revision']:
        raise ReleaseError('the receipt is not the receipt of this build')
    if not VERSION.fullmatch(args.version or ''):
        raise ReleaseError(f'--version {args.version} is not an npm version')
    repo = Path(args.repo)
    dist = '/'.join(part for part in (source['path'], args.out) if part)
    build = writer(repo, 'HEAD', dist)
    if not exists(repo, build, f'{dist}/package-receipt.json') or git(repo, 'show', f'{build}:{dist}/package-receipt.json') != receipt_bytes:
        raise ReleaseError(f'{dist}/package-receipt.json at {build[:12]} is not the receipt given')
    built = tree_entry(repo, build, dist)
    identifier = f'{name}-{source["revision"][:12]}'
    passport = json.loads(git(repo, 'show', f'{build}:{dist}/set.json')) if exists(repo, build, f'{dist}/set.json') else None
    requires = {
        'framework': receipt['framework'].get('release'),
        'source': report['source_revision'],
        'core_runtime': (passport or {}).get('framework', {}).get('core_runtime'),
    }
    lock = {
        'schema': LOCK_SCHEMA,
        'schema_version': 1,
        'id': identifier,
        'package': name,
        'version': args.version,
        'source': {
            'repository': source['repository'],
            'path': source['path'],
            'revision': source['revision'],
            'tree': receipt['package_source']['tree'],
        },
        'build': {
            'revision': build,
            'path': dist,
            'tree': built['runtime_tree'],
            'archive_sha256': built['archive_sha256'],
        },
        'receipt': {'path': f'{dist}/package-receipt.json', 'sha256': sha(receipt_bytes)},
        'output': {
            'manifest_sha256': receipt['output']['manifest_sha256'],
            'archive_sha256': receipt['output']['archive_sha256'],
            'files_count': receipt['output']['files_count'],
        },
        'requires': requires,
        'requires_sets': (passport or {}).get('requires_sets', []),
        'builder': {'repository': 'simai/ui-builder', 'revision': receipt['builder']['revision'], 'clean': receipt['builder']['clean']},
        'claims': {'production_ready': False},
    }
    validate_lock(lock)
    write(repo / 'contracts/releases' / f'{identifier}.lock.json', lock)
    if passport is not None and args.set_out:
        stamped = dict(passport)
        if requires['framework']:
            stamped['framework'] = {**passport['framework'], 'pair': requires['framework']}
        stamped['release'] = {'id': identifier, 'version': args.version, 'source_revision': source['revision']}
        write(args.set_out, stamped)
    print(json.dumps({'id': identifier, 'build': build[:12], 'version': args.version, 'requires': requires}))


def validate_lock(lock):
    where = lock.get('id')
    if set(lock) != LOCK_KEYS or lock['schema'] != LOCK_SCHEMA or lock['schema_version'] != 1:
        raise ReleaseError(f'{where}: not a package release lock v1')
    if not re.fullmatch(r'[a-z][a-z0-9-]*', lock['package']) or lock['id'] != f'{lock["package"]}-{lock["source"]["revision"][:12]}':
        raise ReleaseError(f'{where}: the id is <package>-<12 hex of the source revision>')
    if not VERSION.fullmatch(lock['version']):
        raise ReleaseError(f'{where}: version')
    if not re.fullmatch(r'[0-9a-f]{40}', lock['requires'].get('source') or ''):
        raise ReleaseError(f'{where}: requires names the ui-source revision')
    framework = lock['requires'].get('framework')
    if framework is not None and not re.fullmatch(r'ui-[0-9a-f]{12}', framework):
        raise ReleaseError(f'{where}: requires.framework is a free release id or null')
    if lock['receipt']['path'] != f'{lock["build"]["path"]}/package-receipt.json':
        raise ReleaseError(f'{where}: the receipt lies beside the output')


def check_phase(args):
    """The release gate of a repository that keeps its set builds in git."""
    repo = Path(args.repo)
    directory = repo / 'contracts/releases'
    locks = sorted(path for path in directory.glob('*.lock.json')
                   if json.loads(path.read_text()).get('schema') == LOCK_SCHEMA) if directory.is_dir() else []
    if not locks:
        raise ReleaseError(f'no package release lock in {directory}')
    for path in locks:
        lock = json.loads(path.read_text())
        validate_lock(lock)
        if path.name != f'{lock["id"]}.lock.json':
            raise ReleaseError(f'{path.name}: named after another id')
        build = lock['build']
        dist = build['path']
        if writer(repo, build['revision'], dist) != build['revision']:
            raise ReleaseError(f'{path.name}: the Build commit did not write {dist}')
        live = tree_entry(repo, build['revision'], dist)
        if live['runtime_tree'] != build['tree'] or live['archive_sha256'] != build['archive_sha256']:
            raise ReleaseError(f'{path.name}: {dist} at the Build commit disagrees with the lock')
        receipt_bytes = git(repo, 'show', f'{build["revision"]}:{lock["receipt"]["path"]}')
        if sha(receipt_bytes) != lock['receipt']['sha256']:
            raise ReleaseError(f'{path.name}: the receipt at the Build commit is not the one the lock names')
        receipt = json.loads(receipt_bytes)
        # The output in the repository is, byte for byte, what the receipt lists
        # (the receipt itself aside: it is written beside the output).
        listed = git(repo, 'ls-tree', '-r', '--name-only', build['revision'], dist).decode().splitlines()
        kept = sorted(name[len(dist) + 1:] for name in listed if name != lock['receipt']['path'])
        if kept != sorted(item['path'] for item in receipt['files']):
            raise ReleaseError(f'{path.name}: {dist} holds other files than the receipt lists')
        for item in receipt['files']:
            if sha(git(repo, 'show', f'{build["revision"]}:{dist}/{item["path"]}')) != item['sha256']:
                raise ReleaseError(f'{path.name}: {dist}/{item["path"]} is not the built byte')
        if receipt['output']['manifest_sha256'] != lock['output']['manifest_sha256']:
            raise ReleaseError(f'{path.name}: output digest')
        if args.ui_root and lock['requires']['framework']:
            framework = framework_lock(args.ui_root, lock['requires']['framework'])
            if framework['build_inputs']['source']['commit'] != lock['requires']['source']:
                raise ReleaseError(f'{path.name}: {lock["requires"]["framework"]} was not built from the ui-source revision it requires')
    # The output at HEAD is the newest release's build: a byte changed there
    # after the bind is a release nobody built.
    newest = max((json.loads(path.read_text()) for path in locks),
                  key=lambda lock: int(text(repo, 'rev-list', '--count', lock['build']['revision'])))
    dist = newest['build']['path']
    if text(repo, 'rev-parse', f'HEAD:{dist}') != newest['build']['tree']:
        raise ReleaseError(f'{dist} at HEAD is not the build of {newest["id"]}: release it through the route')
    print(json.dumps({'locks': [path.name for path in locks], 'gate': 'clean', 'head': newest['id']}))


def main():
    parser = argparse.ArgumentParser(description='Bind a component set release kept in git, and check it.')
    parser.add_argument('phase', choices=['output', 'lock', 'check'])
    parser.add_argument('--report', type=Path, help='report.json of verify-package-reproducibility.cjs')
    parser.add_argument('--receipt', type=Path, help='lock: package-receipt.json of the build')
    parser.add_argument('--repo', type=Path, help='the set repository checkout')
    parser.add_argument('--out', default='dist', help='lock: the output folder under the package path (default dist)')
    parser.add_argument('--version', help='lock: the npm version of @simai-studio/<set>')
    parser.add_argument('--set-out', type=Path, help='lock: where to write the stamped passport (a release asset)')
    parser.add_argument('--ui-root', type=Path, help='check: a ui checkout, to check each required free release')
    args = parser.parse_args()
    try:
        {'output': output_phase, 'lock': lock_phase, 'check': check_phase}[args.phase](args)
    except ReleaseError as error:
        print('PACKAGE_RELEASE_ERROR — ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
