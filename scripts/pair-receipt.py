#!/usr/bin/env python3
"""Re-receipt a released component set over another SIMAI Framework pair.

A component set release (publish-package-release.sh) is built over one free
pair, and its receipt names that pair. When a product moves to a newer pair
and the set's own source did not change, the set is not released again: the
same version, the same package bytes, gain a pair receipt
(schema simai.framework.set-pair-receipt v1) that says the set's gates passed
over the new pair against those unchanged bytes. Owner decision 2026-11-07;
decision record ui-control control/decisions/2026-11-07-set-pair-receipts.md.

  run      Gate a release over a pair and write its pair receipt into a new
           workspace. Nothing leaves the workspace: no commit, no upload, no
           index row. Steps, stopping at the first red one:
             1. release   the release lock at the set checkout's HEAD; the
                          released output read from its Build commit is, byte
                          for byte, the archive the lock names
             2. pair      the pair's release lock in the ui checkout, its
                          core.runtime against the set's minimum, its shared
                          runtime against the modules the set imports, its
                          free rules against the set's relations and elements,
                          and (unless --offline) the npm version that carries it
             3. equivalence  the set's release source, repinned to the pair's
                          ui-source in a local commit that is never pushed,
                          rebuilt with ui-builder: the output must be the
                          released output except the passport's
                          framework.source_revision. Any other byte means
                          the set's bytes depend on the pair: release a new
                          version instead.
             4. gates     the set's own gates from its release source
                          (standard simai.component-set, same-gates-for-every-
                          set): unit and registry in the repinned overlay;
                          manifest, browser and first-paint probes over the
                          pair's distr against the UNCHANGED released output
  check    A pair receipt against its release lock: what a consumer (Larena's
           lock) checks before it accepts a set over a pair its receipt does
           not name.
  publish  Lay a checked pair receipt into the set repository
           (contracts/pair-receipts/<release>/<pair>.json, uncommitted), attach
           it to the release as pair-receipt-<pair>.json (gh, unless
           --no-upload) and, with --index, add the pair to the release row of
           the compatibility index (set-index.py pair). Part of the release
           route: run it only where releases are made.

Usage:
  pair-receipt.py run --repo SET_CHECKOUT --release SET-12 --pair ui-12 --workspace NEW_DIR
      [--npm-version V | --offline] [--ui UI] [--ui-source UI_SOURCE] [--builder UI_BUILDER]
  pair-receipt.py check --receipt FILE --lock RELEASE_LOCK
  pair-receipt.py publish --repo SET_CHECKOUT --receipt FILE [--index INDEX] [--no-upload]
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

SCHEMA = 'simai.framework.set-pair-receipt'
SCHEMA_VERSION = 1
LOCK_SCHEMA = 'simai.framework.package-release-lock'
PAIR = re.compile(r'^ui-[0-9a-f]{12}$')
RELEASE = re.compile(r'^[a-z][a-z0-9-]*-[0-9a-f]{12}$')
HEX40 = re.compile(r'^[0-9a-f]{40}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
BUILDER_ROOT = Path(__file__).resolve().parent.parent
RECEIPT_DIRECTORY = 'contracts/pair-receipts'
# The set's own gate scripts, under its package path (simai.component-set
# 1.0.0, same-gates-for-every-set: every set's gates.sh runs these).
GATE_SCRIPTS = ['test.mjs', 'check-registry.mjs', 'run-manifest-probes.mjs', 'run-browser-probes.mjs', 'run-first-paint.mjs']
# The one passport field a repin changes; any other difference is a change of the set.
REPIN_FIELD = ('framework', 'source_revision')
RECEIPT_KEYS = {'schema', 'schema_version', 'set', 'release', 'version', 'repository', 'package', 'built_over',
                'pair', 'checks', 'gates', 'tooling', 'status', 'created_on', 'claims'}


class PairReceiptError(ValueError):
    """The release, the pair or a gate refuses the pair receipt."""


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, BUILDER_ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


receipts = load('write_package_receipt', 'write-package-receipt.py')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args, **kwargs):
    return subprocess.check_output(['git', '-C', str(root), *args], **kwargs)


def text(root, *args):
    return git(root, *args).decode().strip()


def step(name):
    print(f'== {name}', file=sys.stderr, flush=True)


def lock_at(repo, release):
    if not RELEASE.match(release):
        raise PairReceiptError(f'{release}: a release id is <set>-<12 hex>')
    path = Path(repo) / 'contracts/releases' / f'{release}.lock.json'
    if not path.is_file():
        raise PairReceiptError(f'{path} does not exist: the release is not bound in this checkout')
    if text(repo, 'status', '--porcelain', '--', f'contracts/releases/{release}.lock.json'):
        raise PairReceiptError(f'{path.name} has uncommitted changes: a release lock is immutable')
    lock = json.loads(path.read_text())
    if lock.get('schema') != LOCK_SCHEMA or lock.get('schema_version') != 1 or lock.get('id') != release:
        raise PairReceiptError(f'{path.name} is not the package release lock v1 of {release}')
    return lock


def released_output(repo, lock, target):
    """The released output (set.json and smart/), laid from the Build commit and
    proved to be the bytes of the release archive; the receipt beside it."""
    build = lock['build']
    receipt_bytes = git(repo, 'show', f'{build["revision"]}:{lock["receipt"]["path"]}')
    if sha(receipt_bytes) != lock['receipt']['sha256']:
        raise PairReceiptError('the receipt at the Build commit is not the one the lock names')
    if text(repo, 'rev-parse', f'{build["revision"]}:{build["path"]}') != build['tree']:
        raise PairReceiptError(f'{build["path"]} at the Build commit is not the tree the lock names')
    staging = target.parent / f'{target.name}.tar'
    with open(staging, 'wb') as handle:
        subprocess.run(['git', '-C', str(repo), 'archive', '--format=tar', build['revision'], build['path']], stdout=handle, check=True)
    with tarfile.open(staging) as archive:
        archive.extractall(target.parent / f'{target.name}.tree', filter='data')
    staging.unlink()
    shutil.move(str(target.parent / f'{target.name}.tree' / build['path']), target)
    shutil.rmtree(target.parent / f'{target.name}.tree')
    (target / 'package-receipt.json').unlink()
    files = receipts.files_under(target)
    manifest = sha((json.dumps(files, separators=(',', ':')) + '\n').encode())
    archive = receipts.deterministic_tar(target, files)
    output = lock['output']
    if manifest != output['manifest_sha256'] or sha(archive) != output['archive_sha256'] or len(files) != output['files_count']:
        raise PairReceiptError('the output at the Build commit is not the released archive the lock names')
    return json.loads(receipt_bytes), files


def pair_lock(ui, pair):
    if not PAIR.match(pair):
        raise PairReceiptError(f'{pair}: a pair is ui-<12 hex>')
    path = Path(ui) / 'contracts/releases' / f'{pair}.lock.json'
    if not path.is_file():
        raise PairReceiptError(f'no release lock {path}: fetch the ui checkout')
    lock = json.loads(path.read_text())
    if lock.get('schema_version') != 2 or lock.get('compatibility_id') != pair:
        raise PairReceiptError(f'{path.name} is not the v2 release lock of {pair}')
    return lock


def npm_identity(version, pair):
    found = subprocess.run(['npm', 'view', f'@simai-studio/ui@{version}', 'simai', 'dist.integrity', '--json'],
                           capture_output=True, text=True)
    if found.returncode != 0:
        raise PairReceiptError(f'npm has no @simai-studio/ui@{version}: {found.stderr.strip()[:200]}')
    value = json.loads(found.stdout)
    if (value.get('simai') or {}).get('release') != pair:
        raise PairReceiptError(f'@simai-studio/ui@{version} carries {(value.get("simai") or {}).get("release")}, not {pair}')
    return {'package': '@simai-studio/ui', 'version': version, 'integrity': value.get('dist.integrity')}


def passport_difference(left, right):
    """The passport fields that differ, as dotted paths."""
    if isinstance(left, dict) and isinstance(right, dict):
        found = []
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                found.append(key)
            else:
                found.extend(f'{key}.{inner}' if inner else key for inner in passport_difference(left[key], right[key]))
        return found
    return [] if left == right else ['']


def equivalence(rebuilt_root, released_root, released_files):
    rebuilt_files = receipts.files_under(rebuilt_root)
    released = {item['path']: item['sha256'] for item in released_files}
    rebuilt = {item['path']: item['sha256'] for item in rebuilt_files}
    differs = sorted(path for path in set(released) | set(rebuilt) if released.get(path) != rebuilt.get(path))
    passport = []
    if 'set.json' in differs:
        passport = passport_difference(json.loads((Path(released_root) / 'set.json').read_text()),
                                       json.loads((Path(rebuilt_root) / 'set.json').read_text()))
    allowed = differs in ([], ['set.json']) and passport in ([], ['.'.join(REPIN_FIELD)])
    return {
        'status': 'same-bytes' if allowed else 'differs',
        'differs': differs,
        'passport_differs_in': passport,
        'rebuilt_files': len(rebuilt_files),
        'rebuilt_smart_manifest_sha256': sha((json.dumps([item for item in rebuilt_files if item['path'] != 'set.json'], separators=(',', ':')) + '\n').encode()),
    }


def repin(set_root, path, source_revision, release_lock):
    """The release source with the pin moved to the pair's ui-source: a local
    commit (fixed author, date and message, so its tree and id replay), never pushed."""
    package = Path(set_root) / path if path else Path(set_root)
    source_lock = json.loads((package / 'framework.lock.json').read_text())
    source_lock['source']['revision'] = source_revision
    (package / 'framework.lock.json').write_text(json.dumps(source_lock, ensure_ascii=False, indent=2) + '\n')
    passport = json.loads((package / 'set.json').read_text())
    passport['framework']['source_revision'] = source_revision
    (package / 'set.json').write_text(json.dumps(passport, ensure_ascii=False, indent=2) + '\n')
    git(set_root, 'add', '--', str(package / 'framework.lock.json'), str(package / 'set.json'))
    date = text(set_root, 'log', '-1', '--format=%cI', 'HEAD')
    identity = {'GIT_AUTHOR_NAME': 'SIMAI pair receipt', 'GIT_AUTHOR_EMAIL': 'pair-receipt@simai.invalid', 'GIT_AUTHOR_DATE': date,
                'GIT_COMMITTER_NAME': 'SIMAI pair receipt', 'GIT_COMMITTER_EMAIL': 'pair-receipt@simai.invalid', 'GIT_COMMITTER_DATE': date}
    subprocess.run(['git', '-C', str(set_root), '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m',
                    f'Pair receipt: {release_lock["id"]} repinned to ui-source {source_revision[:12]} (local, never pushed)'],
                   check=True, env={**os.environ, **identity})
    return text(set_root, 'rev-parse', 'HEAD')


def last_json(value):
    return json.loads(value[value.rfind('\n{') + 1:])


def run_logged(log, command, cwd=None, env=None):
    with open(log, 'w') as handle:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        raise PairReceiptError(f'{" ".join(str(part) for part in command[:3])} failed (exit {result.returncode}): read {log}')


def run_gates(package, ui_source, free, output, logs, names):
    env = {**os.environ}
    env.setdefault('PLAYWRIGHT_BROWSERS_PATH', str(Path(ui_source).resolve().parent / '.playwright-browsers'))
    scripts = package / 'scripts'
    missing = [name for name in GATE_SCRIPTS if not (scripts / name).is_file()]
    if missing:
        raise PairReceiptError(f'the release source has no {", ".join(missing)}: the set predates the common gates; release a new version')
    step('gate: unit')
    run_logged(logs / 'unit.log', ['node', 'scripts/test.mjs', '--committed', '--ui-source', str(ui_source)], cwd=package, env=env)
    unit = {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}
    for key, value in re.findall(r'^ℹ (tests|pass|fail|skipped) (\d+)', (logs / 'unit.log').read_text(), re.M):
        unit[key] += int(value)
    step('gate: registry')
    with open(logs / 'registry.json', 'w') as handle:
        subprocess.run(['node', str(scripts / 'check-registry.mjs'), '--registry', str(names)], stdout=handle, check=True)
    registry = json.loads((logs / 'registry.json').read_text())
    # Playwright for the probes, as gates.sh lays it: from PLAYWRIGHT_MODULES
    # when no parent folder of the overlay holds it.
    if env.get('PLAYWRIGHT_MODULES'):
        modules = package / '.overlay/node_modules'
        modules.mkdir(parents=True, exist_ok=True)
        for name in ('playwright', 'playwright-core'):
            link = modules / name
            if not link.exists():
                link.symlink_to(Path(env['PLAYWRIGHT_MODULES']) / name)
    step('gate: manifest probes')
    run_logged(logs / 'manifest.log', ['node', str(scripts / 'run-manifest-probes.mjs'), str(free), str(output)], env=env)
    manifest = last_json((logs / 'manifest.log').read_text())
    step('gate: browser probes')
    with open(logs / 'browser.json', 'w') as out, open(logs / 'browser.err', 'w') as err:
        result = subprocess.run(['node', str(scripts / 'run-browser-probes.mjs'), str(free), str(output)], stdout=out, stderr=err, env=env)
    if result.returncode != 0:
        raise PairReceiptError(f'browser probes failed (exit {result.returncode}): read {logs / "browser.err"}')
    browser = json.loads((logs / 'browser.json').read_text())
    step('gate: first paint')
    run_logged(logs / 'first-paint-check.log', ['node', str(scripts / 'run-first-paint.mjs'), 'check', str(free), str(output)], env=env)
    run_logged(logs / 'first-paint-gate.log', ['node', str(scripts / 'run-first-paint.mjs'), 'gate', str(free), str(output)], env=env)
    paint = last_json((logs / 'first-paint-gate.log').read_text())
    gates = {
        'unit': unit,
        'registry': registry,
        'manifest': {'checks': manifest.get('checks'), 'passed': manifest.get('passed'), 'failed': manifest.get('failed')},
        'browser': {'passed': browser.get('passed'), 'failed': len(browser.get('failed') or []), 'skipped': (browser.get('skipped') or {}).get('names', [])},
        'first_paint': {'measured': paint.get('measured'), 'passed': paint.get('passed'), 'cls': paint.get('cls'), 'failed': len(paint.get('failed') or [])},
    }
    red = []
    if unit['fail'] or not unit['pass']:
        red.append(f'unit {unit}')
    if registry.get('problems'):
        red.append(f'registry {registry.get("problems")}')
    if gates['manifest']['failed'] or not gates['manifest']['passed']:
        red.append(f'manifest {gates["manifest"]}')
    if gates['browser']['failed'] or not gates['browser']['passed']:
        red.append(f'browser {gates["browser"]}')
    if gates['first_paint']['failed'] or gates['first_paint']['passed'] != gates['first_paint']['measured']:
        red.append(f'first paint {gates["first_paint"]}')
    if red:
        raise PairReceiptError('the set gates are red over the pair:\n  ' + '\n  '.join(red))
    return gates


def run(args):
    repo = Path(args.repo).resolve()
    # The siblings of the set's main checkout, as gates.sh takes them (a set
    # worktree resolves to the checkout that owns it).
    siblings = Path(text(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')).parent.parent
    ui = Path(args.ui or siblings / 'ui').resolve()
    ui_source = Path(args.ui_source or siblings / 'ui-source').resolve()
    builder = Path(args.builder or siblings / 'ui-builder').resolve()
    workspace = Path(args.workspace)
    if workspace.exists():
        raise PairReceiptError(f'the workspace must not exist: {workspace}')
    workspace.mkdir(parents=True)
    workspace = workspace.resolve()
    logs = workspace / 'logs'
    logs.mkdir()

    step(f'release {args.release}')
    lock = lock_at(repo, args.release)
    name = lock['package']
    built_over = lock['requires'].get('framework')
    if built_over == args.pair:
        raise PairReceiptError(f'{args.release} was built over {args.pair}: its own receipt names that pair')
    released = workspace / 'released'
    package_receipt, released_files = released_output(repo, lock, released)

    step(f'pair {args.pair}')
    target = pair_lock(ui, args.pair)
    pair_commit = target['runtime_sources']['core']['commit']
    pair_source = target['build_inputs']['source']['commit']
    git(ui, 'cat-file', '-e', f'{pair_commit}^{{commit}}')
    core = json.loads(git(ui, 'show', f'{pair_commit}:distr/core/passports/core.runtime.json'))
    passport = json.loads((released / 'set.json').read_text())
    needs = passport['framework']['core_runtime']
    if not receipts_meets(needs, core['version']):
        raise PairReceiptError(f'{args.pair} runs core.runtime {core["version"]}; the set needs {needs}')
    runtime = receipts.check_runtime_against_release(ui, target, package_receipt['framework'].get('runtime'))
    registered, rules = receipts.read_rule_file(released / receipts.RULE_FILE)
    folders = sorted(rule[3:] for rule in rules)
    free_release = receipts.check_against_release(ui, target, name, rules, folders, released, is_set=True)
    names = workspace / 'names-main.json'
    subprocess.run(['curl', '-fsS', 'https://raw.githubusercontent.com/simai/ui-source/main/contracts/registry/names.json', '-o', str(names)], check=True)
    owner = next((item for item in json.loads(names.read_text()).get('owners', []) if item.get('id') == name), None)
    if owner is None or sorted(owner.get('families', [])) != sorted(passport.get('families', [])) or owner.get('repository') != passport.get('repository'):
        raise PairReceiptError(f'the registry at ui-source main no longer gives {name} its families and repository')
    npm = None if args.offline else npm_identity(args.npm_version, args.pair)

    step('equivalence: the release source repinned and rebuilt')
    set_root = workspace / 'set'
    git(repo, 'worktree', 'add', '--detach', '-q', str(set_root), lock['source']['revision'])
    try:
        package = set_root / lock['source']['path'] if lock['source']['path'] else set_root
        pin = repin(set_root, lock['source']['path'], pair_source, lock)
        build = workspace / 'build'
        run_logged(logs / 'build.json', ['node', str(builder / 'scripts/verify-package-reproducibility.cjs'), str(ui_source), str(build),
                                        '--package', name, '--package-source', str(set_root), '--package-path', lock['source']['path'],
                                        '--package-revision', pin, '--package-repository', lock['source']['repository']])
        report = json.loads((build / 'report.json').read_text())
        if report.get('status') != 'PASS' or not report['products']['package']['byte_identical']:
            raise PairReceiptError('the rebuild over the pair is not a passing, byte-identical build')
        same = equivalence(build / report['output'], released, released_files)
        if same['status'] != 'same-bytes':
            raise PairReceiptError(f'over {args.pair} the set builds other bytes ({same["differs"][:8]}, passport {same["passport_differs_in"]}): '
                                   'its bytes depend on the pair, release a new version')

        free_root = workspace / 'free'
        free_root.mkdir()
        archive = subprocess.Popen(['git', '-C', str(ui), 'archive', '--format=tar', pair_commit, 'distr'], stdout=subprocess.PIPE)
        subprocess.run(['tar', '-x', '-C', str(free_root)], stdin=archive.stdout, check=True)
        if archive.wait() != 0:
            raise PairReceiptError(f'git archive of {pair_commit[:12]} distr failed')
        gates = run_gates(package, ui_source, free_root / 'distr', released, logs, names)
    finally:
        if not args.keep_worktree:
            subprocess.run(['git', '-C', str(repo), 'worktree', 'remove', '--force', str(set_root)], capture_output=True)

    builder_revision = text(builder, 'rev-parse', 'HEAD')
    receipt = {
        'schema': SCHEMA,
        'schema_version': SCHEMA_VERSION,
        'set': name,
        'release': lock['id'],
        'version': lock['version'],
        'repository': lock['source']['repository'],
        'package': {
            'source_revision': lock['source']['revision'],
            'build_revision': lock['build']['revision'],
            'receipt_sha256': lock['receipt']['sha256'],
            'manifest_sha256': lock['output']['manifest_sha256'],
            'archive_sha256': lock['output']['archive_sha256'],
            'files_count': lock['output']['files_count'],
        },
        'built_over': {'pair': built_over, 'source_revision': lock['requires']['source']},
        'pair': {
            'id': args.pair,
            'commit': pair_commit,
            'source_revision': pair_source,
            'core_runtime': core['version'],
            'npm': npm,
        },
        'checks': {
            'identity': {'status': 'agrees', 'output': 'the Build commit holds the released archive, byte for byte'},
            'core_runtime': {'needs': needs, 'pair': core['version'], 'status': 'meets'},
            'runtime': runtime,
            'free_release': {'status': free_release['status'], 'relations_and_elements': 'agree'},
            'registry': {'status': 'agrees', 'at': 'ui-source main', 'sha256': sha(names.read_bytes())},
            'equivalence': {**same, 'pin_tree': text(repo, 'rev-parse', f'{pin}^{{tree}}'), 'pin_commit': pin,
                            'builder': report['builder']['revision']},
        },
        'gates': gates,
        'tooling': {
            'builder': {'repository': 'simai/ui-builder', 'revision': builder_revision,
                        'clean': not text(builder, 'status', '--porcelain', '--', 'scripts', 'libs')},
            'pair_receipt_tool': {'repository': 'simai/ui-builder', 'revision': text(BUILDER_ROOT, 'rev-parse', 'HEAD'),
                                  'clean': not text(BUILDER_ROOT, 'status', '--porcelain', '--', 'scripts/pair-receipt.py', 'scripts/write-package-receipt.py')},
            'gates_from': lock['source']['revision'],
            'node': subprocess.check_output(['node', '--version'], text=True).strip(),
        },
        'status': 'passed',
        'created_on': datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
        'claims': {'production_ready': False},
    }
    out = workspace / f'pair-receipt-{args.pair}.json'
    out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    check_receipt(receipt, lock)
    print(json.dumps({'pair_receipt': str(out), 'release': lock['id'], 'version': lock['version'], 'pair': args.pair,
                      'sha256': sha(out.read_bytes()), 'equivalence': same['status'], 'gates': gates}, indent=1))
    print(f'Dry run: nothing committed, uploaded or indexed. Publish with: {Path(__file__).name} publish --repo {repo} --receipt {out}',
          file=sys.stderr)


def receipts_meets(needs, version):
    match = re.fullmatch(r'>=(\d+)\.(\d+)\.(\d+)', needs or '')
    have = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', version or '')
    return bool(match and have) and tuple(map(int, have.groups())) >= tuple(map(int, match.groups()))


def check_receipt(receipt, lock):
    """The checks a consumer runs: the receipt is a passed pair receipt of this
    very release, over another pair than the one it was built over."""
    problems = []
    if set(receipt) != RECEIPT_KEYS or receipt.get('schema') != SCHEMA or receipt.get('schema_version') != SCHEMA_VERSION:
        problems.append(f'not a {SCHEMA} v{SCHEMA_VERSION}')
    else:
        package = receipt['package']
        expected = {
            'set': lock['package'], 'release': lock['id'], 'version': lock['version'], 'repository': lock['source']['repository'],
        }
        for key, value in expected.items():
            if receipt[key] != value:
                problems.append(f'{key} {receipt[key]}, the lock says {value}')
        pairs = {
            'source_revision': lock['source']['revision'], 'build_revision': lock['build']['revision'],
            'receipt_sha256': lock['receipt']['sha256'], 'manifest_sha256': lock['output']['manifest_sha256'],
            'archive_sha256': lock['output']['archive_sha256'], 'files_count': lock['output']['files_count'],
        }
        for key, value in pairs.items():
            if package.get(key) != value:
                problems.append(f'package.{key} {package.get(key)}, the lock says {value}')
        if receipt['built_over'] != {'pair': lock['requires'].get('framework'), 'source_revision': lock['requires']['source']}:
            problems.append('built_over is not what the lock requires')
        pair = receipt['pair']
        if not PAIR.match(str(pair.get('id'))) or pair.get('id') == lock['requires'].get('framework'):
            problems.append(f'pair {pair.get("id")}: another free pair than the one the release was built over')
        if not HEX40.match(str(pair.get('commit'))) or not HEX40.match(str(pair.get('source_revision'))) \
                or pair.get('commit', '')[:12] != str(pair.get('id'))[3:]:
            problems.append('pair commit and source revision')
        if receipt['status'] != 'passed' or receipt['checks'].get('equivalence', {}).get('status') != 'same-bytes':
            problems.append('the receipt did not pass')
        if not DATE.match(str(receipt['created_on'])):
            problems.append('created_on')
    if problems:
        raise PairReceiptError('the pair receipt does not hold:\n  ' + '\n  '.join(problems))
    return {'release': lock['id'], 'pair': receipt['pair']['id'], 'status': 'agrees'}


def check(args):
    receipt = json.loads(Path(args.receipt).read_text())
    lock = json.loads(Path(args.lock).read_text())
    result = check_receipt(receipt, lock)
    print(json.dumps({**result, 'sha256': sha(Path(args.receipt).read_bytes())}))


def publish(args):
    repo = Path(args.repo).resolve()
    data = Path(args.receipt).read_bytes()
    receipt = json.loads(data)
    lock = lock_at(repo, receipt.get('release', ''))
    check_receipt(receipt, lock)
    pair = receipt['pair']['id']
    target = repo / RECEIPT_DIRECTORY / lock['id'] / f'{pair}.json'
    if target.exists():
        raise PairReceiptError(f'{target.relative_to(repo)} exists: a pair receipt is written once')
    # The upload first: a refused upload (the asset exists, no network) leaves
    # neither the repository file nor the index row behind, so the step reruns.
    asset = f'pair-receipt-{pair}.json'
    if not args.no_upload:
        staged = Path(args.receipt).resolve().parent / asset
        if staged != Path(args.receipt).resolve():
            staged.write_bytes(data)
        subprocess.run(['gh', 'release', 'upload', lock['id'], str(staged), '--repo', lock['source']['repository']], check=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    indexed = None
    if args.index:
        indexed = json.loads(subprocess.run([sys.executable, str(BUILDER_ROOT / 'scripts/set-index.py'), 'pair', '--index', str(args.index),
                                             '--receipt', str(target), '--received-on', receipt['created_on']],
                                            check=True, capture_output=True, text=True).stdout)
    print(json.dumps({'laid': str(target.relative_to(repo)), 'asset': None if args.no_upload else asset,
                      'index': indexed, 'sha256': sha(data)}))
    print(f'Commit {target.relative_to(repo)} in {repo} ("Pair receipt: {lock["id"]} over {pair}") and push it with the release route.',
          file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description='Re-receipt a released component set over another SIMAI Framework pair.')
    commands = parser.add_subparsers(dest='command', required=True)
    gate = commands.add_parser('run', help='gate a release over a pair and write the pair receipt (dry: nothing leaves the workspace)')
    gate.add_argument('--repo', required=True, help='the set checkout (its HEAD holds the release lock)')
    gate.add_argument('--release', required=True, help='<set>-<12>')
    gate.add_argument('--pair', required=True, help='ui-<12>')
    gate.add_argument('--workspace', required=True, help='a new directory')
    gate.add_argument('--npm-version', help='the @simai-studio/ui version that carries the pair')
    gate.add_argument('--offline', action='store_true', help='do not ask npm (the receipt says npm: null)')
    gate.add_argument('--ui', help='the ui checkout (default: ../ui beside the set checkout)')
    gate.add_argument('--ui-source', help='the ui-source checkout (default: ../ui-source beside the set checkout)')
    gate.add_argument('--builder', help='the ui-builder checkout that rebuilds, with its node_modules (default: ../ui-builder beside the set checkout)')
    gate.add_argument('--keep-worktree', action='store_true', help='keep the repinned release source in <workspace>/set')
    verify = commands.add_parser('check', help='a pair receipt against its release lock')
    verify.add_argument('--receipt', required=True)
    verify.add_argument('--lock', required=True)
    lay = commands.add_parser('publish', help='lay, attach and index a pair receipt (release route only)')
    lay.add_argument('--repo', required=True)
    lay.add_argument('--receipt', required=True)
    lay.add_argument('--index', type=Path)
    lay.add_argument('--no-upload', action='store_true')
    args = parser.parse_args()
    if args.command == 'run' and not (args.offline or args.npm_version):
        parser.error('run needs --npm-version (or --offline)')
    try:
        {'run': run, 'check': check, 'publish': publish}[args.command](args)
    except (PairReceiptError, receipts.ReceiptError) as error:
        print('PAIR_RECEIPT_ERROR — ' + str(error), file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f'PAIR_RECEIPT_ERROR — {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
