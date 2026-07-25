# Changelog

All notable changes to `ui-builder` are documented in this file.

## Unreleased

### Added

- GitHub repository baseline, Node.js and Yarn runtime contract, and GitHub
  Actions workflows.
- Repository, RTL/PostCSS, and two-wave product reproducibility checks.
- Developer documentation for setup, architecture, product runners, migration
  provenance, and dependency policy.
- Explicit modern `build:*` commands while preserving legacy aliases.
- An English-first contribution and documentation policy for international
  maintainers.

### Changed

- Migrated the independently accepted `sf5.webpack@d4d151c` builder to
  `simai/ui-builder` without rewriting the target repository history.
- Repaired `full.build.js` to use the existing Core, Component, and Utility
  configurations instead of missing legacy configuration modules.
- Removed direct dependencies that duplicated Node.js built-ins or were unused
  by the builder source; accepted output-producing versions remain frozen by
  the original lockfile.
- Reworked all public repository documentation in English and added clear
  onboarding paths for maintainers and build integrators.

### Fixed

- Standardized the brand spelling as `SIMAI` across documentation, package
  metadata, automated checks, and GitHub repository metadata.
- Stable module and chunk identifiers now normalize both lexical and real
  filesystem roots, including the macOS `/tmp` to `/private/tmp` alias.
- Digest-bound compatibility materialization now retains removed Component and
  Smart URL surfaces in addition to legacy Core runtime chunks.
- Stable module collision errors now include the colliding canonical module
  identifier.
- Legacy `plugin` and missing `modal` commands now have explicit compatibility
  behavior instead of failing through missing configuration files.
