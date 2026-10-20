# Changelog

All notable changes to `ui-builder` are documented in this file.

## Unreleased

### Added

- Theme packages (`package.kind: "theme"`, `libs/themePackage.js`): a folder
  with `framework.lock.json` and `theme.json` (a colour, or a hue and a chroma)
  is built with ui-source's own theme calculation at the pinned revision, twice
  and compared, and laid as `theme/theme.css` (the 128 `--sf-<palette>-<tone>`
  primitives), `theme/theme.json` and `theme-receipt.json`.
- `sf-build` (`bin/sf-build.js`) and its Node API (`libs/api.js`): one entry
  point for building the Framework (`framework`) and component packages
  (`package`), the two-wave check alone (`verify package|framework`) and the
  package receipt (`receipt`); a configurable output path (`--out`, laid
  atomically and re-hashed against the report and the receipt), a committed
  configuration file (`sf-build.config.json`, schema
  `schemas/sf-build.config.v1.schema.json`, with a `package.kind` field of
  which `components` is built), a JSON result on stdout (`--json`,
  `simai.sf-build.result.v1`) and stable exit codes. It wraps the existing
  scripts unchanged; the Framework release route is not affected
  (`docs/developer/architecture-sf-build.md`).
- Product component packages (`docs/developer/product-packages.md`): a
  product keeps its own Smart components in a folder of its own repository
  (`framework.lock.json`, `src/smart/<folder>/`, `tests/`), possibly a
  subdirectory of a larger one; `verify-package-reproducibility.cjs --package
  <name>` builds it over the pinned ui-source revision in two byte-identical
  waves (`run-package-product-build.cjs`), with a package rule file
  `SF.RuleLoader.registerPackage('<name>', {rules})`;
  `write-package-receipt.py` writes `package-receipt.json`
  (`simai.framework.product-package-receipt` v1) and a deterministic tar of the
  output, resolves the free release built from the pinned revision and checks
  the rules against it and against the package reference for that name.

- SIMAI Framework Pro as a product: `run-pro-product-build.cjs` builds the four
  Pro Smart components from an overlay (ui-source at the revision
  ui-source-pro pins, with ui-source-pro laid over it) and writes the package
  rule file `smart/rule.js`; `verify-pro-reproducibility.cjs` requires two
  byte-identical waves; `publish-pro-release.sh` and `bind-pro-release.py`
  publish a release into `ui-pro` with its owner manifest and a release lock
  `pro-<12>` that requires the free release (`ui-<12>`) and the ui-source
  revision it was built against (`docs/developer/pro-release.md`).
- The Framework binder drops, from both Smart owner manifests, the components a
  package provides (`ui/contracts/packages`), in the release that stops shipping
  them.

- A deterministic HarfBuzz WASM icon-subset library and CLI with a
  content-addressed WOFF2, CSS and `sf.icon_subset.v1` manifest contract.
- A compatibility adapter that lets `icons.simai.io` retain its `/ms/css` API
  while using the same generator as production builds.
- GitHub repository baseline, Node.js and Yarn runtime contract, and GitHub
  Actions workflows.
- Repository, RTL/PostCSS, and two-wave product reproducibility checks.
- Developer documentation for setup, architecture, product runners, migration
  provenance, and dependency policy.
- Explicit modern `build:*` commands while preserving legacy aliases.
- An English-first contribution and documentation policy for international
  maintainers.

### Deprecated

- SIMAI Framework Pro is superseded by product component packages. Its scripts
  are unchanged and keep building `ui-source-pro` into `ui-pro` until the move;
  `libs/proProduct.js` is now the generic package build with the name `pro`.

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

- `sf-icons build` no longer emits a variable font whose axes do nothing
  (#1). A large instanced Material Symbols subset lost its `gvar` table while
  `fvar` still declared the axes, and the ligature check passed. The emitted
  font is now refused when `fvar` has no `gvar`, when a declared axis changes
  no icon outline, or when it draws more icons than were requested.
- Icon subsets keep only the requested icons. Subsetting by the letters of the
  names kept every ligature they spell (78 names drew 3,465 icons in a
  297,916-byte font); the source is now subset by the requested glyph ids, and
  the same 78 names give a 70,140-byte font that draws 78 icons and keeps
  `gvar`. The generator id is now `@simai/ui-builder/hb-subset@0.10.3`, and the
  CLI reports `drawn_icons`.
- Standardized the brand spelling as `SIMAI` across documentation, package
  metadata, automated checks, and GitHub repository metadata.
- Stable module and chunk identifiers now normalize both lexical and real
  filesystem roots, including the macOS `/tmp` to `/private/tmp` alias.
- Digest-bound compatibility materialization now retains removed Component and
  Smart URL surfaces in addition to legacy Core runtime chunks.
- Compatibility retention now covers the complete generated Core, Component,
  and Smart namespaces while preserving path, digest, and collision gates.
- Stable module collision errors now include the colliding canonical module
  identifier.
- Legacy `plugin` and missing `modal` commands now have explicit compatibility
  behavior instead of failing through missing configuration files.
