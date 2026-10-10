#!/usr/bin/env python3
"""Write the receipt of a v2 Framework release for bind-generated-runtime-contracts.py.

A release is one ui build commit (the last commit that wrote `distr`). Each
runtime tree is named by the build commit that last wrote it as of the
release, because a tree whose bytes did not move keeps its earlier commit;
consumers resolve a release by exactly that commit. The ui-smart mirror, when
given, is named the same way.

Usage:
  write-release-receipt.py --ui-root UI --source-root SOURCE --output FILE
      [--mirror-root UI_SMART] [--release REV] [--source-revision REV]
      [--builder-revision REV]
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


BUILDER_ROOT = Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def text(root, *args):
    return git(root, *args).decode().strip()


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def writer(root, revision, path):
    commit = text(root, 'log', '-1', '--format=%H', revision, '--', path)
    if not commit:
        raise SystemExit(f'no commit in {root} has written {path}')
    return commit


def entry(root, revision, path):
    return {
        'revision': revision,
        'tree': text(root, 'rev-parse', revision + '^{tree}'),
        'runtime_path': path,
        'runtime_tree': text(root, 'rev-parse', revision + ':' + path),
        'candidate_archive': {'sha256': sha(git(root, 'archive', '--format=tar', revision))},
        'runtime_archive': {'sha256': sha(git(root, 'archive', '--format=tar', revision, path))},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ui-root', type=Path, required=True)
    parser.add_argument('--mirror-root', type=Path)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--release', help='the ui build commit; default: the last commit that wrote distr')
    parser.add_argument('--source-revision', help='default: HEAD of --source-root')
    parser.add_argument('--builder-revision', help='the ui-builder commit that built the output; default: HEAD')
    args = parser.parse_args()

    release = text(args.ui_root, 'rev-parse', '--verify', (args.release or writer(args.ui_root, 'HEAD', 'distr')) + '^{commit}')
    if writer(args.ui_root, release, 'distr') != release:
        raise SystemExit(f'{release[:12]} did not write distr: it is not a build commit')
    receipt = {
        'schema': 'simai.framework.generated_runtime_receipt.v2',
        'release_revision': release,
        'runtime_sources': {
            'core': entry(args.ui_root, release, 'distr'),
            'smart': entry(args.ui_root, writer(args.ui_root, release, 'distr/smart'), 'distr/smart'),
        },
        'source_revision': text(args.source_root, 'rev-parse', '--verify', (args.source_revision or 'HEAD') + '^{commit}'),
        'builder_revision': text(BUILDER_ROOT, 'rev-parse', '--verify', (args.builder_revision or 'HEAD') + '^{commit}'),
    }
    if args.mirror_root:
        receipt['mirror'] = entry(args.mirror_root, writer(args.mirror_root, 'HEAD', 'smart'), 'smart')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + '\n')
    smart = receipt['runtime_sources']['smart']['revision']
    print(json.dumps({
        'release': release[:12],
        'smart_written_by': smart[:12],
        'mirror': receipt.get('mirror', {}).get('revision', '')[:12] or None,
        'source': receipt['source_revision'][:12],
        'builder': receipt['builder_revision'][:12],
    }))


if __name__ == '__main__':
    main()
