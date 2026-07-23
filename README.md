# Simai Framework UI Builder

`ui-builder` is the reproducible Webpack build system for the Core, Component,
Utility, and Smart layers of [Simai Framework](https://github.com/simai).

The repository owns build planning, Webpack configuration, deterministic module
and chunk identifiers, asset packaging, and reproducibility verification. The
framework source remains in `simai/ui-loader`; `simai/ui` and `simai/ui-smart`
are generated distributions and must not be edited as source code.

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

A successful `verify` run checks the repository contract, RTL-safe PostCSS
policy, deterministic identifiers, packaging, gzip output, and isolated fixture
builds. It does not publish or modify a generated distribution.

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
  /absolute/path/to/ui-loader/src \
  /absolute/path/to/new-output \
  /absolute/path/to/diagnostics.json
```

Core and Smart use `run-core-product-build.cjs` and
`run-smart-product-build.cjs`. See the
[product runner reference](docs/developer/product-runners.md) for the complete
contract.

## Full reproducibility check

The verifier prepares two isolated frozen runtime pairs and builds all four
products twice:

```bash
node scripts/verify-product-reproducibility.cjs \
  /absolute/path/to/ui-loader \
  /absolute/path/to/new-workspace
```

It succeeds only when the Core, Component, Utility, and Smart manifests are
byte-identical between both waves. Evidence is written to
`<workspace>/report.json`. Existing `ui` and `ui-smart` checkouts are not
required and are not modified.

## GitHub Actions

- **CI** performs a frozen install and runs `yarn run verify` on pushes and pull
  requests.
- **Product reproducibility** is a manually dispatched workflow that accepts an
  exact `ui-loader` branch, tag, or commit and stores both build waves as an
  artifact. A private `simai/ui-loader` checkout requires the
  `UI_LOADER_READ_TOKEN` repository secret with read-only Contents access.

## Documentation

- [Documentation map](docs/README.md)
- [Getting started](docs/developer/getting-started.md)
- [Architecture and ownership](docs/developer/architecture.md)
- [Product runner reference](docs/developer/product-runners.md)
- [Dependency policy](docs/developer/dependency-policy.md)
- [Migration from the legacy builder](docs/developer/migration-from-sf5-webpack.md)
- [Contributing](CONTRIBUTING.md)

Builder verification alone is not a claim of complete LTR/RTL readiness. That
claim requires independent acceptance of the framework component matrix.
