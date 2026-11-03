#!/usr/bin/env python3
"""Write and check the one compatibility index of component sets.

The index (schema simai.framework.set-index v1, ui-source
contracts/schema/set-index.v1.schema.json) answers one question for a page
that names a set without a version: which release of the set runs over this
Core. It is published as the npm package @simai-studio/sets (index.json), and
the Loader reads https://cdn.jsdelivr.net/npm/@simai-studio/sets@1/index.json
unless SF_BOOT_CONFIG.setIndex names another.

One row per released set version, written from the release itself and never
by hand: the stamped passport (bind-package-release.py lock --set-out) and the
release lock it was bound with.

  add     Add the row of a release (and the set's entry the first time).
          Refuses a release over no free pair, a version already indexed, and
          a passport that disagrees with its lock.
  check   The index holds: the format, one row per set and version, ids that
          follow the source revision, every row's set listed, and rows in order
          (by set, then by version).
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

FORMAT = 'simai.framework.set-index'
NAME = re.compile(r'^[a-z][a-z0-9-]*$')
VERSION = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$')
MINIMUM = re.compile(r'^>=\d+\.\d+\.\d+$')
HEX40 = re.compile(r'^[0-9a-f]{40}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
SET_KEYS = {'id', 'title', 'repository', 'npm', 'licence', 'docs'}
ROW_KEYS = {'set', 'release', 'version', 'source_revision', 'framework', 'requires_sets', 'receipt_sha256', 'archive_sha256', 'published_on'}
EMPTY = {
    'schema': FORMAT,
    'schema_version': 1,
    'summary': 'Every released SIMAI component set version and the SIMAI Framework it runs over.',
    'sets': [],
    'releases': [],
}


class IndexError_(ValueError):
    """The index, or a row offered to it, does not hold."""


def version_key(version):
    match = VERSION.match(version)
    major, minor, patch, pre = match.groups()
    # A pre-release sorts below its release.
    return (int(major), int(minor), int(patch), pre is None, pre or '')


def read(path):
    path = Path(path)
    return json.loads(path.read_text()) if path.is_file() else json.loads(json.dumps(EMPTY))


def write(path, index):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n')


def problems(index):
    found = []
    if index.get('schema') != FORMAT or index.get('schema_version') != 1:
        found.append(f'schema: not {FORMAT} v1')
    if set(index) - {'schema', 'schema_version', 'summary', 'sets', 'releases'}:
        found.append('unknown top-level keys')
    sets = index.get('sets') if isinstance(index.get('sets'), list) else []
    rows = index.get('releases') if isinstance(index.get('releases'), list) else []
    listed = set()
    for at, entry in enumerate(sets):
        where = f'sets[{at}]'
        if set(entry) != SET_KEYS:
            found.append(f'{where}: keys {sorted(entry)}')
            continue
        if not NAME.match(entry['id']) or entry['id'] in listed:
            found.append(f'{where}.id')
        listed.add(entry['id'])
        if entry['npm'] != f'@simai-studio/{entry["id"]}':
            found.append(f'{where}.npm is not @simai-studio/{entry["id"]}')
        if entry['licence'].get('class') not in ('framework', 'simai-pro'):
            found.append(f'{where}.licence.class')
    seen = set()
    for at, row in enumerate(rows):
        where = f'releases[{at}]'
        if not set(row) <= ROW_KEYS or not (ROW_KEYS - {'archive_sha256'}) <= set(row):
            found.append(f'{where}: keys {sorted(row)}')
            continue
        if row['set'] not in listed:
            found.append(f'{where}: set {row["set"]} is not in sets')
        if not VERSION.match(row['version']):
            found.append(f'{where}.version')
            continue
        if (row['set'], row['version']) in seen:
            found.append(f'{where}: {row["set"]} {row["version"]} is indexed twice')
        seen.add((row['set'], row['version']))
        if not HEX40.match(row['source_revision']) or row['release'] != f'{row["set"]}-{row["source_revision"][:12]}':
            found.append(f'{where}.release is not <set>-<12 of source_revision>')
        framework = row['framework']
        if set(framework) != {'core_runtime', 'source_revision', 'pair'} or not MINIMUM.match(framework['core_runtime']) \
                or not HEX40.match(framework['source_revision']) or not re.match(r'^ui-[0-9a-f]{12}$', framework['pair'] or ''):
            found.append(f'{where}.framework')
        if not HEX64.match(row['receipt_sha256']) or ('archive_sha256' in row and not HEX64.match(row['archive_sha256'])):
            found.append(f'{where}: digests')
        if not DATE.match(row['published_on']):
            found.append(f'{where}.published_on')
    order = [(row.get('set', ''), version_key(row['version'])) for row in rows if VERSION.match(str(row.get('version', '')))]
    if order != sorted(order):
        found.append('releases: not in order of set, then version')
    if [entry.get('id') for entry in sets] != sorted(entry.get('id') for entry in sets):
        found.append('sets: not in order of id')
    return found


def add(args):
    index = read(args.index)
    passport = json.loads(Path(args.passport).read_text())
    lock = json.loads(Path(args.lock).read_text())
    release = passport.get('release') or {}
    if lock.get('schema') != 'simai.framework.package-release-lock' or lock['package'] != passport['id']:
        raise IndexError_('the lock is not a package release lock of this set')
    if release.get('id') != lock['id'] or release.get('version') != lock['version'] or release.get('source_revision') != lock['source']['revision']:
        raise IndexError_('the passport is not stamped with this release (bind-package-release.py lock --set-out)')
    pair = passport['framework'].get('pair')
    if not pair:
        raise IndexError_(f'{lock["id"]} was built over no free pair: a set is indexed only over a released SIMAI Framework')
    if any(row['set'] == lock['package'] and row['version'] == lock['version'] for row in index['releases']):
        raise IndexError_(f'{lock["package"]} {lock["version"]} is already indexed')
    if not any(entry['id'] == passport['id'] for entry in index['sets']):
        index['sets'].append({
            'id': passport['id'],
            'title': passport['title'],
            'repository': passport['repository'],
            'npm': f'@simai-studio/{passport["id"]}',
            'licence': passport['licence'],
            'docs': passport['docs'],
        })
        index['sets'].sort(key=lambda entry: entry['id'])
    row = {
        'set': lock['package'],
        'release': lock['id'],
        'version': lock['version'],
        'source_revision': lock['source']['revision'],
        'framework': {
            'core_runtime': passport['framework']['core_runtime'],
            'source_revision': lock['requires']['source'],
            'pair': pair,
        },
        'requires_sets': passport.get('requires_sets', []),
        'receipt_sha256': lock['receipt']['sha256'],
        'archive_sha256': lock['output']['archive_sha256'],
        'published_on': args.published_on,
    }
    index['releases'].append(row)
    index['releases'].sort(key=lambda item: (item['set'], version_key(item['version'])))
    found = problems(index)
    if found:
        raise IndexError_('the index would not hold:\n  ' + '\n  '.join(found))
    write(args.index, index)
    print(json.dumps({'added': row['release'], 'version': row['version'], 'index': str(args.index),
                      'sha256': hashlib.sha256(Path(args.index).read_bytes()).hexdigest()}))


def check(args):
    index = read(args.index)
    found = problems(index)
    if found:
        raise IndexError_('\n  '.join([str(args.index)] + found))
    print(json.dumps({'index': str(args.index), 'sets': len(index['sets']), 'releases': len(index['releases']), 'gate': 'clean'}))


def main():
    parser = argparse.ArgumentParser(description='Write and check the compatibility index of component sets.')
    parser.add_argument('command', choices=['add', 'check'])
    parser.add_argument('--index', type=Path, required=True, help='index.json (created by add when missing)')
    parser.add_argument('--passport', type=Path, help='add: the stamped passport of the release')
    parser.add_argument('--lock', type=Path, help='add: the release lock')
    parser.add_argument('--published-on', help='add: the day the npm version was published (YYYY-MM-DD)')
    args = parser.parse_args()
    try:
        if args.command == 'add':
            if not (args.passport and args.lock and args.published_on and DATE.match(args.published_on)):
                parser.error('add needs --passport, --lock and --published-on YYYY-MM-DD')
            add(args)
        else:
            check(args)
    except IndexError_ as error:
        print('SET_INDEX_ERROR — ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
