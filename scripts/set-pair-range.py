#!/usr/bin/env python3
"""The SIMAI Framework interface a released component set depends on, and the
free pairs that keep it.

A component set release is built over one free pair (`ui-<12>`), and its
package receipt names that pair. A consumer that pins exact pairs (Larena)
otherwise needs a new release or a pair receipt (pair-receipt.py) for every
pair it moves to. A pair range (schema `simai.framework.set-pair-range` v1)
is written once per release, from the released bytes, and lists exactly what
those bytes take from the free pair at runtime:

  core_runtime  the lowest core.runtime version (the passport's);
  runtime       the shared runtime ABI and, per shared module the bundles ask
                SF.runtimeModule for, the names they import (the receipt's);
  relations     every relation of the set's rule file to a rule that is not
                the set's own: it must resolve on the pair, to a free rule or
                through a live forward (smart-rule-forwards.v1.json); a
                relation to a set the passport requires is listed, not
                checked against the pair;
  elements      the set's tags: no free element may take one;
  free_elements the free tags the set's scripts render (`<sf-x`,
                createElement("sf-x")) that the built-over pair has: each must
                stay a tag of a free rule (a dated former tag counts);
  core_folder   the set's package core: the pair must not ship it in
                distr/smart;
  variables     the --sf-* custom properties the set reads with no fallback,
                does not set itself, and the built-over pair's sheets declare:
                the pair's sheets must still declare each;
  js_api        the window.SF names the bundles call (SF.<Global>[.<member>])
                that the built-over pair's public-js-api.json lists as public:
                each must stay public there.

Every check reads the pair's distribution only (a `ui` checkout: its release
lock and `distr` at the core commit), the same thing a consumer pins, so a
consumer can repeat it without ui-source or a build. A pair is within the
range when every requirement holds; the range of the release is the set of
such pairs, not a list. The release, its receipt and its exact pair are
untouched: an exact pin and a pair receipt stay valid as before.

What a range does not cover (the reason it is a separate acceptance, chosen
by the consumer, and never written into the release): behaviour behind an
unchanged interface (a token's value, a free component's look, smart-base
behaviour under the same ABI), Framework code a bundle inlined at build time
(a rebuild over the pair may give other bytes; pair-receipt.py measures
that), and the set's own gates over the pair. See ui-control
control/evidence/2026-11-09-set-pair-range/proposal.md.

  write   The range of a release: from a set checkout (--repo, --release:
          the release lock at HEAD, the released output from its Build
          commit, proved to be the archive the lock names) or from a laid
          output (--output DIR holding package-receipt.json, --lock FILE).
          The interface is taken over the built-over pair and must hold
          there.
  check   One or more pairs (--pair, repeated, or --all for every plain
          release lock in the ui checkout) against a range; with --lock, the
          range must also describe that very release. Exit 0 when every pair
          given is within, 1 when one is outside, 2 when the range is invalid.

Usage:
  set-pair-range.py write (--repo SET_CHECKOUT --release SET-12 | --output DIR --lock LOCK)
      --ui UI [--as-of YYYY-MM-DD] [--to FILE]
  set-pair-range.py check --range FILE --ui UI (--pair ui-12 ... | --all)
      [--lock LOCK] [--as-of YYYY-MM-DD]
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

SCHEMA = 'simai.framework.set-pair-range'
SCHEMA_VERSION = 1
LOCK_SCHEMA = 'simai.framework.package-release-lock'
PAIR = re.compile(r'^ui-[0-9a-f]{12}$')
PAIR_LOCK = re.compile(r'^(ui-[0-9a-f]{12})\.lock\.json$')
RELEASE = re.compile(r'^[a-z][a-z0-9-]*-[0-9a-f]{12}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
VERSION_FLOOR = re.compile(r'^>=\s*(\d+)\.(\d+)\.(\d+)$')
BUILDER_ROOT = Path(__file__).resolve().parent.parent
CORE_PASSPORT = 'distr/core/passports/core.runtime.json'
RUNTIME_CONTRACT = 'distr/core/contracts/shared-runtime.v1.json'
JS_API_CONTRACT = 'distr/core/contracts/public-js-api.json'
FREE_RULES = 'distr/rule/rule.json'
# A declaration of a custom property in a sheet, and a read of one. A read
# with a fallback (`var(--sf-x, 4px)`) still draws when the pair drops the
# property, so only a bare read is a requirement.
DECLARED = re.compile(r'(--sf-[a-z0-9_-]+)\s*:')
READ_BARE = re.compile(r'var\(\s*(--sf-[a-z0-9_-]+)\s*\)')
SET_BY_SCRIPT = re.compile(r'setProperty\(\s*["\'`](--sf-[a-z0-9_-]+)["\'`]')
RENDERED_TAG = re.compile(r'(?:<|createElement\(\s*["\'`])(sf-[a-z0-9]+(?:-[a-z0-9]+)*)')
JS_NAME = re.compile(r'\bSF\.([A-Za-z_$][A-Za-z0-9_$]*)(?:\.([A-Za-z_$][A-Za-z0-9_$]*))?')
RANGE_KEYS = {'schema', 'schema_version', 'set', 'release', 'version', 'repository', 'package', 'built_over',
              'requires', 'interface_sha256', 'expires', 'not_covered', 'tooling', 'created_on', 'claims'}
REQUIRES_KEYS = {'core_runtime', 'runtime', 'relations', 'elements', 'free_elements', 'core_folder', 'variables', 'js_api'}
NOT_COVERED = [
    'behaviour behind an unchanged interface: token values, free component looks, smart-base behaviour under the same ABI',
    'Framework code a bundle inlined at build time: a rebuild over the pair may give other bytes (pair-receipt.py equivalence)',
    'the set gates over the pair: unit, manifest, browser and first-paint probes',
    'the attributes, events and slots of the free elements the set renders (renamed only with dated aliases)',
    'window.SF reached through an alias the scan cannot see (const s = SF; s.x)',
]


class RangeError(ValueError):
    """The release, the range or the pair cannot be read as one."""


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, BUILDER_ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


receipts = load('write_package_receipt', 'write-package-receipt.py')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def git(root, *args, **kwargs):
    return subprocess.check_output(['git', '-C', str(root), *args], **kwargs)


def text(root, *args):
    return git(root, *args).decode().strip()


def today():
    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()


# ---------------------------------------------------------------- the release

def read_lock(path, release=None):
    lock = json.loads(Path(path).read_text())
    if lock.get('schema') != LOCK_SCHEMA or lock.get('schema_version') != 1 or not RELEASE.match(str(lock.get('id'))):
        raise RangeError(f'{path} is not a package release lock v1')
    if release is not None and lock['id'] != release:
        raise RangeError(f'{path} is the lock of {lock["id"]}, not {release}')
    if not PAIR.match(str((lock.get('requires') or {}).get('framework'))):
        raise RangeError(f'{lock["id"]}: requires.framework is not a free pair')
    return lock


def check_output_against_lock(output, lock):
    """The laid output is the released one: package-receipt.json is the receipt
    the lock names, and the rest hashes to its manifest and file count."""
    receipt_path = Path(output) / 'package-receipt.json'
    if not receipt_path.is_file():
        raise RangeError(f'{output} holds no package-receipt.json')
    receipt_bytes = receipt_path.read_bytes()
    if sha(receipt_bytes) != lock['receipt']['sha256']:
        raise RangeError(f'{receipt_path} is not the receipt {lock["id"]} names')
    files = [item for item in receipts.files_under(output) if item['path'] != 'package-receipt.json']
    manifest = sha((json.dumps(files, separators=(',', ':')) + '\n').encode())
    if manifest != lock['output']['manifest_sha256'] or len(files) != lock['output']['files_count']:
        raise RangeError(f'{output} is not the released output of {lock["id"]} (manifest or file count)')
    receipt = json.loads(receipt_bytes)
    if not receipt.get('set'):
        raise RangeError(f'{lock["id"]} is not a component set: its receipt has no set block')
    return receipt


def lay_release(repo, release, target):
    """The released output of a set checkout's release, from its Build commit."""
    lock_path = Path(repo) / 'contracts/releases' / f'{release}.lock.json'
    if not lock_path.is_file():
        raise RangeError(f'{lock_path} does not exist: the release is not bound in this checkout')
    lock = read_lock(lock_path, release)
    build = lock['build']
    if text(repo, 'rev-parse', f'{build["revision"]}:{build["path"]}') != build['tree']:
        raise RangeError(f'{build["path"]} at the Build commit is not the tree {release} names')
    staging = Path(tempfile.mkdtemp(prefix='set-pair-range-'))
    try:
        archive = staging / 'build.tar'
        with open(archive, 'wb') as handle:
            subprocess.run(['git', '-C', str(repo), 'archive', '--format=tar', build['revision'], build['path']], stdout=handle, check=True)
        with tarfile.open(archive) as tar:
            tar.extractall(staging / 'tree', filter='data')
        shutil.move(str(staging / 'tree' / build['path']), target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return lock


# ---------------------------------------------------------------- the pair

class Pair:
    """A free pair as its distribution shows it: the release lock in a ui
    checkout and the files of distr at the core commit."""

    def __init__(self, ui, pair):
        if not PAIR.match(pair):
            raise RangeError(f'{pair}: a pair is ui-<12 hex>')
        path = Path(ui) / 'contracts/releases' / f'{pair}.lock.json'
        if not path.is_file():
            raise RangeError(f'no release lock {path}: fetch the ui checkout')
        lock = json.loads(path.read_text())
        if lock.get('schema_version') != 2 or lock.get('compatibility_id') != pair:
            raise RangeError(f'{path.name} is not the v2 release lock of {pair}')
        self.ui = ui
        self.id = pair
        self.commit = lock['runtime_sources']['core']['revision']
        self.source_revision = (((lock.get('build_inputs') or {}).get('source')) or {}).get('commit')
        self._cache = {}

    def exists(self, path):
        return receipts.exists(self.ui, self.commit, path)

    def json(self, path):
        if path not in self._cache:
            self._cache[path] = json.loads(git(self.ui, 'show', f'{self.commit}:{path}')) if self.exists(path) else None
        return self._cache[path]

    def core_runtime(self):
        passport = self.json(CORE_PASSPORT)
        return passport.get('version') if passport else None

    def free_rules(self):
        rules = self.json(FREE_RULES) or []
        return {rule['name'] for rule in rules}, {tag for rule in rules for tag in rule.get('tags', [])}

    def forwards(self):
        return receipts.read_rule_forwards(self.ui, self.commit)

    def declared_variables(self):
        if 'variables' not in self._cache:
            found = subprocess.run(['git', '-C', str(self.ui), 'grep', '-h', '-o', '-E', '-e', r'--sf-[a-z0-9_-]+[[:space:]]*:',
                                    self.commit, '--', 'distr/*.css', ':!*.min.css'], capture_output=True, text=True)
            if found.returncode not in (0, 1):
                raise RangeError(f'git grep over {self.id} distr failed: {found.stderr.strip()[:200]}')
            self._cache['variables'] = {line.split(':')[0].strip() for line in found.stdout.splitlines() if line.strip()}
        return self._cache['variables']

    def public_js(self):
        """{global: members or None}: the public names; None when the global
        lists no members (any member is its own business)."""
        contract = self.json(JS_API_CONTRACT)
        if contract is None:
            return None
        return {item['name'][3:]: (set(item['members']) if item.get('members') else None)
                for item in contract.get('globals', []) if item.get('status') == 'public' and str(item.get('name', '')).startswith('SF.')}


def meets(floor, version):
    match = VERSION_FLOOR.match(str(floor or ''))
    if not match:
        raise RangeError(f'core_runtime {floor!r} is not ">=X.Y.Z"')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(version or '')):
        return False
    return tuple(int(part) for part in version.split('.')) >= tuple(int(part) for part in match.groups())


# ---------------------------------------------------------------- the interface

def output_text(output):
    """Every script and sheet of the set's output, by kind."""
    scripts, sheets = [], []
    for path in sorted(Path(output).rglob('*')):
        if path.is_file() and path.suffix == '.js':
            scripts.append(path.read_text(errors='replace'))
        elif path.is_file() and path.suffix == '.css':
            sheets.append(path.read_text(errors='replace'))
    return '\n'.join(scripts), '\n'.join(sheets)


def interface(output, receipt, built_over, as_of):
    """What the released bytes take from the free pair, read over the pair
    they were built over. Every requirement holds there by construction; a
    relation the pair cannot resolve is a set's the passport requires, or
    the release is refused."""
    _, rules = receipts.read_rule_file(Path(output) / receipts.RULE_FILE)
    passport = json.loads((Path(output) / receipts.SET_PASSPORT).read_text())
    core = receipt.get('core') or {}
    core_rule = core.get('rule')
    own = set(rules)
    free_names, free_tags = built_over.free_rules()
    forwards = built_over.forwards()
    relations, via_sets, problems = [], [], []
    for rule_name, rule in sorted(rules.items()):
        for relation in rule.get('relation', []):
            name = relation['name']
            if name in own:
                continue
            target, hops, why = receipts.resolve_relation(name, free_names, forwards, as_of)
            if target is None and why is None and passport.get('requires_sets'):
                via_sets.append(name)
            elif target is None:
                problems.append(f'{rule_name}: relation {name} ' + (why or f'is no rule of {built_over.id}'))
            else:
                relations.append({'name': name, 'resolves_to': target,
                                  **({'remove_after': min(hop['remove_after'] for hop in hops)} if hops else {})})
    if problems:
        raise RangeError(f'the release and its own pair {built_over.id} disagree:\n  ' + '\n  '.join(problems))
    relations = sorted({item['name']: item for item in relations}.values(), key=lambda item: item['name'])

    scripts, sheets = output_text(output)
    # A script sets a property in a style it writes (`--sf-x:${v}`) or with setProperty.
    own_variables = set(DECLARED.findall(sheets)) | set(DECLARED.findall(scripts)) | set(SET_BY_SCRIPT.findall(scripts))
    read = set(READ_BARE.findall(sheets)) | set(READ_BARE.findall(scripts))
    framework_variables = built_over.declared_variables()
    variables = sorted((read - own_variables) & framework_variables)
    unbound = sorted(read - own_variables - framework_variables)

    public = built_over.public_js()
    used = {(match.group(1), match.group(2)) for match in JS_NAME.finditer(scripts)}
    js_api = []
    if public is not None:
        for name, member in sorted(used, key=lambda item: (item[0], item[1] or '')):
            if name not in public:
                continue
            members = public[name]
            if member is not None and members is not None and member in members:
                js_api.append(f'{name}.{member}')
            elif member is None or members is None:
                js_api.append(name)
        js_api = sorted(set(js_api))

    own_tags = {tag for rule in rules.values() for tag in rule.get('tags', [])}
    free_elements = sorted((set(RENDERED_TAG.findall(scripts)) - own_tags) & free_tags)

    runtime = (receipt.get('framework') or {}).get('runtime')
    requires = {
        'core_runtime': passport['framework']['core_runtime'],
        'runtime': None if runtime is None else {'abi': runtime.get('abi'), 'modules': {key: sorted(value) for key, value in sorted((runtime.get('modules') or {}).items())}},
        'relations': relations,
        'elements': sorted(tag for rule_name, rule in rules.items() if rule_name != core_rule for tag in rule.get('tags', [])),
        'free_elements': free_elements,
        'core_folder': core.get('folder'),
        'variables': variables,
        'js_api': js_api,
    }
    notes = {'relations_to_required_sets': sorted(set(via_sets)), 'variables_bound_by_the_page': unbound,
             'js_names_not_public': sorted({f'SF.{name}' for name, _ in used if public is None or name not in public})}
    expires = min((item['remove_after'] for item in relations if 'remove_after' in item), default=None)
    return requires, notes, expires


def check_pair(requires, pair, as_of):
    """The problems of a pair against a range's requirements; none: within."""
    problems = []
    version = pair.core_runtime()
    if not meets(requires['core_runtime'], version):
        problems.append(f'core_runtime: {pair.id} runs {version}, the set needs {requires["core_runtime"]}')
    runtime = requires.get('runtime')
    contract = pair.json(RUNTIME_CONTRACT)
    if runtime is not None and runtime.get('abi') is not None:
        if contract is None:
            problems.append(f'runtime: {pair.id} publishes no {RUNTIME_CONTRACT}')
        else:
            if contract.get('abi') != runtime['abi']:
                problems.append(f'runtime: ABI {contract.get("abi")}, the set was built for ABI {runtime["abi"]}')
            for module_id, names in runtime['modules'].items():
                offered = (contract.get('modules') or {}).get(module_id)
                if offered is None:
                    problems.append(f'runtime: {pair.id} does not hand out {module_id}')
                    continue
                exports = offered.get('exports')
                missing = [] if exports is None else [name for name in names if name != '*' and name not in exports]
                if missing:
                    problems.append(f'runtime: {module_id} no longer exports {", ".join(missing)}')
    free_names, free_tags = pair.free_rules()
    forwards = pair.forwards()
    for relation in requires['relations']:
        target, _, why = receipts.resolve_relation(relation['name'], free_names, forwards, as_of)
        if target is None:
            problems.append(f'relations: {relation["name"]} ' + (why or f'is no rule of {pair.id} nor a name it forwards'))
    taken = sorted(set(requires['elements']) & free_tags)
    if taken:
        problems.append(f'elements: {pair.id} has free elements {", ".join(taken)}')
    lost_tags = [tag for tag in requires['free_elements'] if tag not in free_tags]
    if lost_tags:
        problems.append(f'free_elements: {pair.id} has no free element {", ".join(lost_tags)}')
    if requires.get('core_folder') and pair.exists(f'distr/smart/{requires["core_folder"]}'):
        problems.append(f'core_folder: {pair.id} ships distr/smart/{requires["core_folder"]}')
    declared = pair.declared_variables()
    gone = [name for name in requires['variables'] if name not in declared]
    if gone:
        problems.append(f'variables: {pair.id} no longer declares {", ".join(gone[:12])}' + (f' and {len(gone) - 12} more' if len(gone) > 12 else ''))
    if requires['js_api']:
        public = pair.public_js()
        if public is None:
            problems.append(f'js_api: {pair.id} publishes no {JS_API_CONTRACT}')
        else:
            lost = []
            for item in requires['js_api']:
                name, _, member = item.partition('.')
                if name not in public or (member and public[name] is not None and member not in public[name]):
                    lost.append(f'SF.{item}')
            if lost:
                problems.append(f'js_api: {pair.id} no longer lists as public {", ".join(lost)}')
    return problems


# ---------------------------------------------------------------- commands

def write(args):
    as_of = args.as_of or today()
    with tempfile.TemporaryDirectory(prefix='set-pair-range-') as scratch:
        if args.repo:
            output = Path(scratch) / 'released'
            lock = lay_release(Path(args.repo).resolve(), args.release, output)
        else:
            output = Path(args.output)
            lock = read_lock(args.lock)
        receipt = check_output_against_lock(output, lock)
        built_over = Pair(args.ui, lock['requires']['framework'])
        requires, notes, expires = interface(output, receipt, built_over, as_of)
    own = check_pair(requires, built_over, as_of)
    if own:
        raise RangeError(f'the interface does not hold over its own pair {built_over.id}:\n  ' + '\n  '.join(own))
    document = {
        'schema': SCHEMA,
        'schema_version': SCHEMA_VERSION,
        'set': lock['package'],
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
        'built_over': {'pair': built_over.id, 'commit': built_over.commit, 'source_revision': lock['requires']['source']},
        'requires': requires,
        'interface_sha256': sha(canonical(requires)),
        'expires': expires,
        'not_covered': NOT_COVERED,
        'tooling': {
            'repository': 'simai/ui-builder',
            'revision': text(BUILDER_ROOT, 'rev-parse', 'HEAD'),
            'clean': not text(BUILDER_ROOT, 'status', '--porcelain', '--', 'scripts/set-pair-range.py', 'scripts/write-package-receipt.py'),
            'as_of': as_of,
            'notes': notes,
        },
        'created_on': today(),
        'claims': {'production_ready': False},
    }
    payload = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode()
    target = Path(args.to) if args.to else Path(f'pair-range-{lock["id"]}.json')
    target.write_bytes(payload)
    print(json.dumps({'range': str(target), 'release': lock['id'], 'built_over': built_over.id, 'sha256': sha(payload),
                      'interface_sha256': document['interface_sha256'], 'expires': expires,
                      'counts': {key: len(value) for key, value in requires.items() if isinstance(value, list)}}))


def read_range(path, lock_path=None):
    try:
        document = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise RangeError(f'{path}: {error}') from None
    if (not isinstance(document, dict) or set(document) != RANGE_KEYS or document.get('schema') != SCHEMA
            or document.get('schema_version') != SCHEMA_VERSION or not isinstance(document.get('requires'), dict)
            or set(document['requires']) != REQUIRES_KEYS):
        raise RangeError(f'{path} is not a {SCHEMA} v{SCHEMA_VERSION}')
    if sha(canonical(document['requires'])) != document.get('interface_sha256'):
        raise RangeError(f'{path}: interface_sha256 is not the digest of its requires')
    if lock_path:
        lock = read_lock(lock_path)
        expected = {
            'release': lock['id'], 'set': lock['package'], 'version': lock['version'],
            'package.receipt_sha256': lock['receipt']['sha256'], 'package.archive_sha256': lock['output']['archive_sha256'],
            'package.manifest_sha256': lock['output']['manifest_sha256'], 'package.source_revision': lock['source']['revision'],
            'built_over.pair': lock['requires']['framework'],
        }
        for key, value in expected.items():
            found = document
            for part in key.split('.'):
                found = (found or {}).get(part) if isinstance(found, dict) else None
            if found != value:
                raise RangeError(f'{path}: {key} {found}, the lock says {value}')
    return document


def check(args):
    as_of = args.as_of or today()
    document = read_range(args.range, args.lock)
    if args.all:
        pairs = sorted(match.group(1) for path in (Path(args.ui) / 'contracts/releases').iterdir()
                       if (match := PAIR_LOCK.match(path.name)))
    else:
        pairs = args.pair
    results = []
    for pair_id in pairs:
        pair = Pair(args.ui, pair_id)
        problems = check_pair(document['requires'], pair, as_of)
        results.append({'pair': pair_id, 'status': 'outside' if problems else 'within',
                        **({'basis': 'built-over'} if pair_id == document['built_over']['pair'] else {}),
                        **({'problems': problems} if problems else {})})
    within = sum(1 for item in results if item['status'] == 'within')
    print(json.dumps({'release': document['release'], 'interface_sha256': document['interface_sha256'], 'as_of': as_of,
                      'within': within, 'outside': len(results) - within, 'pairs': results}, ensure_ascii=False, indent=2))
    return 0 if within == len(results) else 1


def main():
    parser = argparse.ArgumentParser(description='The SIMAI Framework interface of a released component set, and the pairs that keep it.')
    commands = parser.add_subparsers(dest='command', required=True)
    writing = commands.add_parser('write')
    writing.add_argument('--repo', help='a set checkout whose contracts/releases holds the release lock')
    writing.add_argument('--release', help='with --repo: the release, <set>-<12 hex>')
    writing.add_argument('--output', help='the laid released output (set.json, smart/, package-receipt.json)')
    writing.add_argument('--lock', help='with --output: the release lock')
    writing.add_argument('--ui', required=True, help='a ui checkout holding the built-over pair')
    writing.add_argument('--as-of', help='the date forwards must be live on; default: today, UTC')
    writing.add_argument('--to', help='default: pair-range-<release>.json here')
    checking = commands.add_parser('check')
    checking.add_argument('--range', required=True)
    checking.add_argument('--ui', required=True)
    checking.add_argument('--pair', action='append', default=[])
    checking.add_argument('--all', action='store_true', help='every plain ui-<12> release lock of the ui checkout')
    checking.add_argument('--lock', help='the release lock the range must describe')
    checking.add_argument('--as-of')
    args = parser.parse_args()
    if getattr(args, 'as_of', None) is not None and not DATE.match(args.as_of):
        parser.error('--as-of takes a date, YYYY-MM-DD')
    if args.command == 'write' and bool(args.repo) == bool(args.output):
        parser.error('write takes --repo with --release, or --output with --lock')
    if args.command == 'write' and ((args.repo and not args.release) or (args.output and not args.lock)):
        parser.error('write takes --repo with --release, or --output with --lock')
    if args.command == 'check' and bool(args.pair) == args.all:
        parser.error('check takes --pair (repeated) or --all')
    try:
        if args.command == 'write':
            write(args)
            return 0
        return check(args)
    except RangeError as error:
        print('SET_PAIR_RANGE_ERROR — ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
