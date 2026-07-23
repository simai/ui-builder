# Changelog

Все значимые изменения ui-builder фиксируются в этом файле.

## Unreleased

### Added

- GitHub repository baseline, Node/Yarn runtime contract and GitHub Actions.
- Repository, RTL/PostCSS and two-wave product reproducibility checks.
- Developer documentation for ownership, migration and dependency policy.
- Explicit modern `build:*` commands while preserving legacy aliases.

### Changed

- Migrated the independently accepted `sf5.webpack@d4d151c` builder to
  `simai/ui-builder` without rewriting the target repository history.
- Repaired `full.build.js` to use the existing Core, Component and Utility
  configurations instead of missing legacy config modules.
- Removed direct dependencies that duplicated Node built-ins or were unused by
  the builder source; accepted output-producing versions remain frozen by the
  original lockfile.

### Fixed

- Stable module collision errors now include the colliding canonical module
  identifier.
- Legacy `plugin` and missing `modal` commands now have explicit compatibility
  behavior instead of failing through missing config files.
