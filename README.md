# SIMAI Framework UI Builder

`ui-builder` is the reproducible Webpack build system for the Core, Component,
Utility, and Smart layers of [SIMAI Framework](https://github.com/simai).

The repository owns build planning, Webpack configuration, deterministic module
and chunk identifiers, asset packaging, and reproducibility verification. The
framework source is `simai/ui-source`; `simai/ui` is the one generated
distribution -- Core, Component, Utility and Smart under `distr/` -- and must
not be edited as source code.

Documentation (Russian): https://ui.simai.io/

## Requirements

- Node.js `20.19.5` for acceptance and CI; minimum supported version `20.19.0`
- Yarn Classic `1.22.22`
- Webpack `5.108.4`

The committed `yarn.lock` is part of the accepted output contract. Do not
refresh it as routine maintenance: output-producing dependency changes require
the reproducibility process described in the
[dependency policy](docs/developer/dependency-policy.md).

## Quick start

```bash
git clone git@github.com:simai/ui-builder.git
cd ui-builder
corepack enable
yarn install --frozen-lockfile --ignore-scripts --non-interactive
yarn run verify
```

Use `yarn run verify`, not `yarn verify`. Yarn Classic also defines `check` as a
built-in command, so the explicit `run` form prevents command ambiguity.

A successful `verify` run checks the repository and English/SIMAI brand
contracts, RTL-safe PostCSS policy, deterministic identifiers, packaging, gzip
output, and isolated fixture builds. It does not publish or modify a generated
distribution.

## Build commands

The legacy Webpack configurations read source and output paths from a local
`.env` file. Copy [`.env.example`](.env.example), provide absolute paths for the
targets you use, and keep `.env` untracked.

| Command | Result |
| --- | --- |
| `yarn build:core` | Build normal and minified Core output |
| `yarn build:component` | Build normal and minified Component output |
| `yarn build:utility` | Build normal and minified Utility output |
| `yarn build:all` | Build Core, Component, and Utility once |
| `yarn watch` | Watch Core, Component, and Utility inputs |

The historical aliases `full`, `core`, `utility`, `comp`, `plugin`, `dev`,
`outline`, `divider`, and `editorjs` remain available for existing automation.
`plugin` emits a deprecation warning and builds Component. The unavailable
historical `modal` source target fails with an explicit error instead of running
an incorrect build.

## Product builds

Use the product runners for deterministic builds in automation. They require
absolute paths, a new output directory, and independently prepared dependency
runtimes:

```bash
SF_BUILDER_DEPENDENCY_ROOT=/absolute/path/to/builder-runtime \
SF_SOURCE_DEPENDENCY_ROOT=/absolute/path/to/source-runtime \
node scripts/run-component-utility-product-build.cjs \
  component \
  /absolute/path/to/ui-builder \
  /absolute/path/to/ui-source/src \
  /absolute/path/to/new-output \
  /absolute/path/to/diagnostics.json
```

Core and Smart use `run-core-product-build.cjs` and
`run-smart-product-build.cjs`. A product's own Smart components (a product
component package, loaded as `SF_BOOT_CONFIG.packages.<name>`) are built with
`verify-package-reproducibility.cjs` and pinned by the receipt of
`write-package-receipt.py`; see
[product component packages](docs/developer/product-packages.md). See the
[product runner reference](docs/developer/product-runners.md) for the complete
contract.

## Using sf-build in a product

`sf-build` is one command line and Node API for building SIMAI Framework and
its extension packages into an output path of your choice
([design and status](docs/developer/architecture-sf-build.md)). A product
(Larena, Docara, an external author) commits `sf-build.config.json`
([schema](schemas/sf-build.config.v1.schema.json)) beside its package folder:

```json
{
  "schema": "simai.sf-build.config.v1",
  "package": { "name": "acme", "kind": "components", "path": "resources/ui" },
  "framework": { "source": "../ui-source" },
  "out": "public/vendor/acme-ui"
}
```

The package folder holds `framework.lock.json` and `src/smart/<folder>/`
([product component packages](docs/developer/product-packages.md)). Then, from
the product directory, with a ui-builder checkout that has run
`yarn install --frozen-lockfile`:

```bash
node /path/to/ui-builder/bin/sf-build.js package --replace-out --json
```

It builds the committed package twice over the ui-source revision the lock
pins, requires both waves to be byte-identical, writes the receipt, and lays
`public/vendor/acme-ui/smart/...`, `package-receipt.json` and
`package-acme.tar`. Serve `smart/` as `SF_BOOT_CONFIG.packages.acme.base`
beside the free release, and pin the receipt.

- Options override the file: `--out`, `--ui-source` (or `SF_BUILD_UI_SOURCE`),
  `--ui` (or `SF_BUILD_UI`, to name the free release in the receipt and check
  the package against it), `--name`, `--package-root`, `--package-revision`.
- `--json` prints one result object (`simai.sf-build.result.v1`) on stdout.
  Exit codes: `0` built, `1` build failed or waves differ, `2` usage,
  configuration or output conflict, `3` receipt refused, `4` environment.
- `sf-build verify package` runs the two-wave check alone;
  `sf-build framework --ui-source <dir> --out <dir>` builds the Framework into
  the layout the release route publishes; `sf-build --help` lists everything.
- From Node: `require("<ui-builder>/libs/api").buildPackage({ out, replaceOut: true })`
  resolves to the same result object.

Requirements: Node.js `>=20.19.0`, git, Python 3 (the receipt), and the Yarn
cache or network access for the frozen dependency runtimes.

## Reconcile a consumer with a release

A consumer of SIMAI Framework units (the Figma UI kit, a documentation site, a
product) keeps a usage record (`simai.framework.unit-usage`) and compares it
with a release's unit inventory before it publishes (standard
`simai.linkage`). The command needs Node.js only, not the sources:

```sh
node scripts/reconcile.mjs --record usage.json --inventory ui-<12> \
  --releases https://raw.githubusercontent.com/simai/ui/main/contracts/releases \
  --journal https://raw.githubusercontent.com/simai/ui-source/main/contracts/changes/journal.json
```

Every unit of every place gets `current`, `update-available`, `former-name`,
`action-needed` or `missing`, including the token sets, fonts and icon sets
it depends on. See [Usage records and reconcile](docs/developer/linkage-reconcile.md).

## Full reproducibility check

The verifier prepares two isolated frozen runtime pairs and builds all four
products twice:

```bash
node scripts/verify-product-reproducibility.cjs \
  /absolute/path/to/ui-source \
  /absolute/path/to/new-workspace
```

It succeeds only when the Core, Component, Utility, and Smart manifests are
byte-identical between both waves. Evidence is written to
`<workspace>/report.json`. An existing `ui` checkout is not required and is not
modified.

When a release must retain digest-bound runtime assets from accepted historical
distributions, first materialize their manifest-defined records into one
read-only compatibility corpus. Then bind all three compatibility inputs and
require that mode explicitly:

```bash
export SF_LEGACY_COMPATIBILITY_ROOT=/absolute/path/to/materialized-corpus
export SF_LEGACY_COMPATIBILITY_MANIFEST=/absolute/path/to/lineage.json
export SF_LEGACY_COMPATIBILITY_REVISION=<manifest-revision-binding>

node scripts/verify-product-reproducibility.cjs \
  /absolute/path/to/ui-source \
  /absolute/path/to/new-workspace \
  --require-legacy-compatibility
```

The verifier validates the binding before creating the workspace and records
its revision, manifest digest, record count, and resolved paths in
`report.json`. The two-argument form remains available for source-only builds
that intentionally do not materialize legacy runtime assets.

## GitHub Actions

- **CI** performs a frozen install and runs `yarn run verify` on pushes and pull
  requests.
- **Product reproducibility** is a manually dispatched workflow that accepts an
  exact `ui-source` branch, tag, or commit and stores both build waves as an
  artifact. `simai/ui-source` is public and starts from a snapshot taken on
  2026-10-13; a revision of an earlier release lives only in the private
  `simai/ui-source-history`, which the workflow falls back to with the
  `UI_LOADER_READ_TOKEN` secret (read-only Contents access).

## Documentation

- [Documentation map](docs/README.md)
- [Getting started](docs/developer/getting-started.md)
- [Architecture and ownership](docs/developer/architecture.md)
- [Product runner reference](docs/developer/product-runners.md)
- [Product component packages](docs/developer/product-packages.md)
- [sf-build: one build tool for the Framework and its packages](docs/developer/architecture-sf-build.md)
- [Publishing a Framework release](docs/developer/framework-release.md)
- [Dependency policy](docs/developer/dependency-policy.md)
- [Icon subset generator](docs/developer/icon-subsets.md)
- [Usage records and reconcile (simai.linkage)](docs/developer/linkage-reconcile.md)
- [Migration from the legacy builder](docs/developer/migration-from-sf5-webpack.md)
- [Contributing](CONTRIBUTING.md)

Builder verification alone is not a claim of complete LTR/RTL readiness. That
claim requires independent acceptance of the framework component matrix.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

Apache License, Version 2.0 -- see [LICENSE](LICENSE) and [NOTICE](NOTICE).
