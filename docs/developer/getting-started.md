# Getting started

This guide takes a new maintainer from a clean checkout to a verified local
builder. It does not write generated framework distributions.

## Prerequisites

- Git access to `simai/ui-builder`
- Node.js `20.19.5`
- Corepack
- a POSIX-compatible shell for the documented examples

## Install

```bash
git clone git@github.com:simai/ui-builder.git
cd ui-builder
corepack enable
yarn install --frozen-lockfile --ignore-scripts --non-interactive
```

Do not run a lockfile refresh during setup. The committed dependency graph is
part of the reproducibility contract.

## Verify the repository

```bash
yarn run verify
```

The command runs:

- `check:repository` for package, runtime, command, and lockfile contracts;
- `check:rtl-postcss` for logical CSS retention and fallback ordering;
- `test:reproducibility` for deterministic planning, Webpack configuration,
  lifecycle, packaging, compatibility, and isolated fixture builds.

The verification command does not require `.env` and does not write to `ui` or
`ui-smart`.

## Configure legacy build commands

Copy `.env.example` to `.env` and set the absolute source and output paths
needed by the legacy Webpack configuration you intend to run:

```bash
cp .env.example .env
```

Never commit `.env`. Product runners use explicit path arguments and dependency
runtime variables instead of this legacy configuration.

## Run a deterministic product check

Use a clean `ui-loader` checkout and a workspace path that does not yet exist:

```bash
node scripts/verify-product-reproducibility.cjs \
  /absolute/path/to/ui-loader \
  /absolute/path/to/new-workspace
```

Review `<workspace>/report.json`. A successful report has `status: "PASS"` and
`byte_identical: true` for all four products.

## Next steps

- Read [Architecture and ownership](architecture.md) before changing pipeline
  code.
- Read [Runtime and dependency policy](dependency-policy.md) before updating a
  dependency.
- Use the [Product runner reference](product-runners.md) for CI integration.
