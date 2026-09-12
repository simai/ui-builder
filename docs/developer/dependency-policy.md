# Runtime and dependency policy

## Accepted runtime

Node.js `20.19.5`, Yarn Classic `1.22.22`, Webpack `5.108.4`, and the committed
`yarn.lock` form the accepted compatibility runtime. Install dependencies with:

```bash
yarn install --frozen-lockfile --ignore-scripts --non-interactive
```

Webpack is maintained on its current major line. Other output-producing
dependencies cannot be upgraded based on version numbers alone because they
participate in the generated distribution format.

## Why the lockfile is intentionally pinned

A trial upgrade of the Sass, PostCSS, Babel, and loader stack exposed two
incompatible changes:

1. A newer `postcss-preset-env` configuration physically transformed logical
   declarations and violated the required logical-retention and fallback-order
   contract.
2. A newer loader graph produced duplicate Webpack runtime identifiers and
   stopped deterministic product builds before output materialization.

The repository structure, CI, Node.js contract, and Webpack version were
modernized, while the accepted output-producing dependency graph remained
frozen. This is a deliberate compatibility pin, not an unattended update.

The repository contract binds the lockfile to SHA-256
`b8cef635055fd29c5c7784f2c93de78780a86929e530b4a04457f9b01c2a9529`.

The icon subset compiler uses exact-pinned `subset-font` `2.6.0`. The
Material Symbols package is a development-only ligature fixture; production
callers provide their exact source font and SHA-256 through the compiler API
or the `sf-icons` CLI.

Final HTML discovery uses exact-pinned `parse5` `7.3.0`, so icon names are
collected from parsed elements and attributes rather than guessed with regular
expressions.

Exact-pinned `fontverter` `2.0.0` and `harfbuzzjs` `0.10.3` shape every
requested ligature before subsetting. An unknown icon name therefore fails
before any output packet is written.

## Dependency update gate

Every dependency update is a separate candidate and must:

1. update the dependency specification and lockfile on an isolated branch;
2. pass `yarn run verify` on the required Node.js version;
3. run two frozen Core, Component, Utility, and Smart build waves against an
   exact `ui-source` revision;
4. classify every generated-output difference;
5. demonstrate the expected logical CSS retention and fallback order;
6. receive independent acceptance for the exact commit and Git tree;
7. update generated distributions only in a separately authorized step.

Never combine a toolchain upgrade with an unreviewed publication to `ui` or
`ui-smart`.
