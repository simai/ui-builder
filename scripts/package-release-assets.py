#!/usr/bin/env python3
"""Lay out and check the GitHub release assets of a component set release.

A set release `<set>-<12>` (standard simai.component-set, one-release-route)
is a GitHub release on the set's repository. It carries:

  package-<set>-<12>.tar    the archive, under the release's own name;
  package-<set>.tar         the same bytes under the set's name alone: the
                            name consumers fetch (Larena's frontend runtime
                            artifact downloads package-<set>.tar, as it
                            downloads package-pro.tar from a Pro release);
  package-<set>.tar.sha256  `<sha256>  package-<set>.tar`;
  package-receipt.json      the receipt of the build;
  set-<set>-<12>.json       the passport stamped with its release block
                            (a set's release only: a package whose receipt
                            has no set block carries none);
  pair-range.json           a set release over a free pair: its pair range
                            (simai.framework.set-pair-range v1,
                            set-pair-range.py write). Optional: releases
                            before standard simai.component-set 1.2.0 carry
                            none, or gain it later, uploaded beside the
                            assets that were there.

Both archives are one archive: their sha256 is the receipt's
output.archive_sha256 and the release lock's output.archive_sha256.

Phases:

  prepare   From the work folder publish-package-release.sh leaves (the
            receipt, the archive it wrote, the stamped set.json), write the
            assets into --out, then check them.
  check     Check the assets in a folder (--dir), or of a published release
            (--github <owner/repo>: downloaded with gh into a new temporary
            folder). With --lock, the archive is also the lock's.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

RELEASE = re.compile(r'^(?P<set>[a-z][a-z0-9-]*)-(?P<hex>[0-9a-f]{12})$')
RANGE = 'pair-range.json'
RANGE_SCHEMA = 'simai.framework.set-pair-range'


class AssetError(Exception):
    pass


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def parse_release(identifier):
    match = RELEASE.match(identifier or '')
    if not match:
        raise AssetError(f'{identifier!r} is not a release id <set>-<12 hex>')
    return match['set'], match['hex']


def names(identifier, is_set=True):
    name, _ = parse_release(identifier)
    value = {
        'versioned': f'package-{identifier}.tar',
        'archive': f'package-{name}.tar',
        'sha256': f'package-{name}.tar.sha256',
        'receipt': 'package-receipt.json',
    }
    if is_set:
        value['passport'] = f'set-{identifier}.json'
    return value


def check_folder(folder, identifier, lock=None):
    """Return the archive sha256 when the assets in folder agree, else raise."""
    folder = Path(folder)
    name, _ = parse_release(identifier)
    receipt_path = folder / 'package-receipt.json'
    if not receipt_path.is_file():
        raise AssetError(f'{identifier}: missing assets package-receipt.json')
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    expected = names(identifier, bool(receipt.get('set')))
    missing = [asset for asset in expected.values() if not (folder / asset).is_file()]
    if missing:
        raise AssetError(f'{identifier}: missing assets ' + ', '.join(missing))
    versioned = sha(folder / expected['versioned'])
    archive = sha(folder / expected['archive'])
    if versioned != archive:
        raise AssetError(f'{identifier}: {expected["archive"]} ({archive}) and {expected["versioned"]} ({versioned}) are not the same bytes')
    line = (folder / expected['sha256']).read_text(encoding='utf-8').strip()
    if line != f'{archive}  {expected["archive"]}':
        raise AssetError(f'{identifier}: {expected["sha256"]} reads {line!r}, not "{archive}  {expected["archive"]}"')
    if receipt.get('package') != name:
        raise AssetError(f'{identifier}: the receipt is for package {receipt.get("package")!r}, not {name}')
    if receipt.get('output', {}).get('archive_sha256') != archive:
        raise AssetError(f'{identifier}: the archive ({archive}) is not the receipt\'s output.archive_sha256 ({receipt.get("output", {}).get("archive_sha256")})')
    if 'passport' in expected:
        passport = json.loads((folder / expected['passport']).read_text(encoding='utf-8'))
        if passport.get('id') != name or (passport.get('release') or {}).get('id') != identifier:
            raise AssetError(f'{identifier}: {expected["passport"]} is not the stamped passport of {identifier}')
    if (folder / RANGE).is_file():
        check_range(folder / RANGE, identifier, archive, sha(folder / expected['receipt']))
    if lock is not None:
        value = json.loads(Path(lock).read_text(encoding='utf-8'))
        if value.get('id') != identifier:
            raise AssetError(f'{identifier}: the lock is {value.get("id")!r}')
        if value.get('output', {}).get('archive_sha256') != archive:
            raise AssetError(f'{identifier}: the archive ({archive}) is not the lock\'s output.archive_sha256')
        if value.get('receipt', {}).get('sha256') != sha(folder / expected['receipt']):
            raise AssetError(f'{identifier}: the receipt is not the one the lock binds')
    return archive


def check_range(path, identifier, archive, receipt_sha256):
    """The pair range describes this very release: its id, archive and receipt,
    and an interface_sha256 that is the digest of its requires."""
    try:
        document = json.loads(Path(path).read_text(encoding='utf-8'))
    except ValueError as error:
        raise AssetError(f'{identifier}: {RANGE} is not JSON: {error}') from None
    name, _ = parse_release(identifier)
    if not isinstance(document, dict) or document.get('schema') != RANGE_SCHEMA or document.get('schema_version') != 1:
        raise AssetError(f'{identifier}: {RANGE} is not a {RANGE_SCHEMA} v1')
    package = document.get('package') or {}
    if document.get('release') != identifier or document.get('set') != name:
        raise AssetError(f'{identifier}: {RANGE} is the range of {document.get("release")!r}')
    if package.get('archive_sha256') != archive or package.get('receipt_sha256') != receipt_sha256:
        raise AssetError(f'{identifier}: {RANGE} names another archive or receipt')
    requires = json.dumps(document.get('requires'), ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    if hashlib.sha256(requires).hexdigest() != document.get('interface_sha256'):
        raise AssetError(f'{identifier}: {RANGE} interface_sha256 is not the digest of its requires')


def prepare_phase(args):
    work = Path(args.work)
    receipt_path = work / 'package-receipt.json'
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    name, _ = parse_release(args.release)
    if receipt.get('package') != name:
        raise AssetError(f'the receipt in {work} is for package {receipt.get("package")!r}, not {name}')
    built = work / f'package-{name}.tar'
    if not built.is_file():
        raise AssetError(f'no archive {built.name} in {work}')
    is_set = bool(receipt.get('set'))
    passport = work / 'set.json'
    if is_set and not passport.is_file():
        raise AssetError(f'no stamped set.json in {work}: a set release carries its passport')
    out = Path(args.out)
    if out.exists() and any(out.iterdir()):
        raise AssetError(f'{out} is not empty')
    out.mkdir(parents=True, exist_ok=True)
    expected = names(args.release, is_set)
    shutil.copyfile(built, out / expected['versioned'])
    shutil.copyfile(built, out / expected['archive'])
    archive = sha(out / expected['archive'])
    (out / expected['sha256']).write_text(f'{archive}  {expected["archive"]}\n', encoding='utf-8')
    shutil.copyfile(receipt_path, out / expected['receipt'])
    if is_set:
        shutil.copyfile(passport, out / expected['passport'])
    laid = sorted(expected.values())
    if (work / RANGE).is_file():
        shutil.copyfile(work / RANGE, out / RANGE)
        laid = sorted(laid + [RANGE])
    check_folder(out, args.release, args.lock)
    print(json.dumps({'release': args.release, 'archive_sha256': archive, 'assets': laid, 'out': str(out)}))


def check_phase(args):
    if bool(args.dir) == bool(args.github):
        raise AssetError('give --dir or --github')
    if args.dir:
        archive = check_folder(args.dir, args.release, args.lock)
    else:
        with tempfile.TemporaryDirectory(prefix='set-release-assets-') as folder:
            def download(asset):
                done = subprocess.run(['gh', 'release', 'download', args.release, '-R', args.github, '-p', asset, '-D', folder],
                                      capture_output=True, text=True)
                if done.returncode != 0:
                    raise AssetError(f'{args.release} on {args.github}: {asset} could not be downloaded: {done.stderr.strip()}')
            download('package-receipt.json')
            receipt = json.loads((Path(folder) / 'package-receipt.json').read_text(encoding='utf-8'))
            for asset in names(args.release, bool(receipt.get('set'))).values():
                if asset != 'package-receipt.json':
                    download(asset)
            listed = subprocess.run(['gh', 'release', 'view', args.release, '-R', args.github, '--json', 'assets', '-q', '.assets[].name'],
                                    capture_output=True, text=True)
            if listed.returncode != 0:
                raise AssetError(f'{args.release} on {args.github}: the assets could not be listed: {listed.stderr.strip()}')
            if RANGE in listed.stdout.split():
                download(RANGE)
            archive = check_folder(folder, args.release, args.lock)
    print(f'ASSETS {args.release} archive_sha256={archive} (package-{parse_release(args.release)[0]}.tar and package-{args.release}.tar are the same bytes)')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    phases = parser.add_subparsers(dest='phase', required=True)
    prepare = phases.add_parser('prepare', help='write and check the assets of a release')
    prepare.add_argument('--work', required=True, help='the work folder of publish-package-release.sh')
    prepare.add_argument('--release', required=True, help='<set>-<12>')
    prepare.add_argument('--out', required=True, help='an empty or new folder for the assets')
    prepare.add_argument('--lock', help='the release lock to check the archive against')
    prepare.set_defaults(run=prepare_phase)
    check = phases.add_parser('check', help='check the assets of a release')
    check.add_argument('--release', required=True, help='<set>-<12>')
    check.add_argument('--dir', help='a folder holding the assets')
    check.add_argument('--github', help='owner/repo whose release <set>-<12> to download and check')
    check.add_argument('--lock', help='the release lock to check the archive against')
    check.set_defaults(run=check_phase)
    args = parser.parse_args(argv)
    try:
        args.run(args)
    except AssetError as error:
        print(f'ASSETS_FAILED — {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
