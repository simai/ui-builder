# Migration from `sf5.webpack`

This page records the provenance and compatibility boundary of the initial
GitHub migration. `sf5.webpack` is a historical repository name, not the public
name of the current builder.

## Provenance

The initial import came from a clean legacy worktree:

- repository: `sf5.webpack`;
- revision: `d4d151cce5f0955b1d838e8127ba7555df98d05c`;
- Git tree: `5616c21d714eeb676933107d879f833f86d0b2c5`;
- acceptance baseline: Node.js 20 test suite `100/100` and two byte-identical
  Core, Component, Utility, and Smart build waves.

The import intentionally excluded `yarn-error.log` and an empty tracked file
named `yarn`. They were local legacy artifacts, not build inputs. The GitHub
repository history was preserved; the import was committed after its initial
repository commit rather than rewriting that commit.

## Command compatibility

- `core`, `utility`, `comp`, `full`, `dev`, `outline`, `divider`, and `editorjs`
  remain available.
- `plugin` is a warning alias that builds Component.
- `modal` fails closed with an explanation because the accepted legacy source
  did not contain that target.
- New automation should use `build:*`, product runners, and `verify`.

## Deliberately excluded legacy state

- Bitbucket Pipelines configuration, replaced by GitHub Actions;
- machine-specific paths such as `/var/www/.../sf5.webpack`;
- direct writes to generated `ui` or `ui-smart` repositories;
- legacy release, tag, deployment, or runtime state.

## Current canonical repository

`https://github.com/simai/ui-builder` is the canonical build-system repository.
Future documentation and commit subjects use English. Historical identifiers
remain in provenance records where removing them would reduce traceability.
