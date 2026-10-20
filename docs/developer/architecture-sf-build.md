# sf-build: one build tool for the Framework and its packages

Status: phase 1 implemented (`bin/sf-build.js`, `libs/api.js`,
`schemas/sf-build.config.v1.schema.json`); phases 2 and 3 are proposals.

The owner decision of 2026-10-11 (the Framework grows through packages, not
through edits to its core) asks for ui-builder to become **one installable
tool** with a CLI and a Node API and a configurable output path, usable by the
Framework's own release, by products (Larena, Docara) in their builds, and by
external authors. This document assesses where the builder stands against that
goal, describes the target design, and lists what phase 1 delivers and what is
left.

## 1. Assessment of the current builder

### What is generic already

- **The lifecycle.** `buildPlan`, `webpackConfigFactory`,
  `productWebpackRuntime`, `componentBuildLifecycle` and `generatedPackaging`
  take every path as an argument. Nothing in them knows where `ui`, `ui-smart`
  or a product lives. They are the reusable core of the tool.
- **The product runners** (`scripts/run-*-product-build.cjs`): four absolute
  paths, a fresh output root, a JSON diagnostics file, stable invocation error
  codes. A machine contract, not a developer convenience.
- **The two-wave verifiers** (`verify-product-reproducibility.cjs`,
  `verify-package-reproducibility.cjs`): each wave prepares frozen dependency
  runtimes from lockfiles, builds into a new root, and the two manifests must
  be byte-identical. `report.json` is machine-readable.
- **The package route** already accepts a package folder anywhere in any git
  repository (`resolvePackageSource`), reads only committed files
  (`git archive`), and writes a receipt with hashes and a deterministic tar.
  It is the shape every future package kind can follow.

### What is coupled to the Framework's own release

| Coupling | Where | Effect on external use |
| --- | --- | --- |
| Release route lays into sibling checkouts | `publish-framework-release.sh` (`--ui ../ui --mirror ../ui-smart --source ../ui-source`), `bind-generated-runtime-contracts.py` | Correct for the Framework, irrelevant for a product: a product never commits into `ui`. It stays a Framework-only route. |
| Output paths are fixed inside a workspace | verifiers write `wave-1/output/<product>/...`; the receipt writes beside `report.json` | A caller must know the workspace layout and copy files out itself. No "output path". |
| Hard-coded repository ids | `packageProduct.js` requires `source.repository === "simai/ui-source"`; the receipt records `simai/ui-source` and `simai/ui-builder` | A fork, a mirror or a vendored ui-source cannot be named. Acceptable today; must become data when external authors appear. |
| The receipt executes code from a `ui` checkout | `write-package-receipt.py --ui` imports `ui/scripts/build-framework-registry.py` to compute relation ids | The tool's result depends on a script in another repository at whatever revision is checked out. |
| The builder records its own git commit | verifiers call `git rev-parse HEAD` on the builder root | An npm-installed copy has no `.git`; the verifiers fail. Phase 1 refuses early with `BUILDER_NOT_A_CHECKOUT`. |
| ui-source is private | `README.md` (`UI_LOADER_READ_TOKEN`) | An external author cannot build a package at all without read access to `simai/ui-source`. The largest blocker for external authors. |

### What blocks external use

1. **No single entry point.** Ten scripts with positional absolute-path
   arguments, two languages, and a documented order (verify, then receipt, then
   copy). Each consumer would reimplement the glue.
2. **Python and Node split.** The verifiers and runners are Node; the receipts
   and the release binders are Python 3. A product build needs both
   interpreters. The release binders legitimately belong to the Framework
   release; the package receipt does not have to be Python.
3. **The builder's own `node_modules` leaks into product builds.**
   `libs/postcssLateLogicalFallbacks.js` resolves `postcss` and
   `postcss-dir-pseudo-class` from the builder root, not from the frozen
   builder runtime of the wave. A checkout without `yarn install` fails with
   "Cannot find module 'postcss'" (found while building the phase 1 fixture);
   a checkout with a different install could build with different PostCSS
   bytes than the runtime the report claims. This is a reproducibility defect
   independent of sf-build and should be fixed first in phase 2 (resolve both
   through the builder dependency runtime, as the loaders are).
   **Fixed** in 9662cb6: both resolve from the wave's dependency runtime
   (`SF_BUILDER_DEPENDENCY_ROOT`), PostCSS itself comes from the running
   loader; a Framework build with no builder `node_modules` gives the same four
   product manifests as before.
4. **Dependency footprint.** Every build tool (webpack, sass, babel, PostCSS)
   is a `devDependency`. A two-wave build installs the builder's
   `package.json` + `yarn.lock` twice into fresh runtimes through
   `npm exec yarn@1.22.22` (about 87 MB each; seconds with a warm Yarn cache,
   network otherwise). An installed copy must therefore ship `yarn.lock`, and a
   machine without the Yarn cache needs the network.
5. **Private package, `UNLICENSED`.** `package.json` has `"private": true` and
   `"license": "UNLICENSED"`, and `verify-repository-contract.cjs` asserts
   `private === true`. Nobody outside SIMAI may install it. (Section 6 lists
   what publishing needs; it is the owner's call.)
6. **Webpack configurations and `.env` at the root.** `core.webpack.js`,
   `component.webpack.js`, `utility.webpack.js`, `*.build.js`,
   `webpack.editorjs*.js` read source and output paths from a local `.env`.
   They are the legacy developer route (`yarn build:*`, `yarn watch`), kept for
   compatibility. They are not used by the product runners and must not ship
   in an installable tool.
7. **The Framework build reads a working tree, the package build reads
   commits.** `verify-product-reproducibility.cjs` builds `ui-source/src` as it
   is on disk; `verify-package-reproducibility.cjs` lays both trees from git.
   Phase 1 keeps both as they are (the release route depends on the first);
   the target is commits for both, with the working tree as an explicit
   development option.

## 2. Target design

One tool, **`sf-build`**: a CLI (`bin/sf-build.js`) and a Node API
(`libs/api.js`) over the same functions. The CLI is a thin argument parser;
everything it can do the API can do, with the same result object.

### Commands

| Command | What it does | Laid into `--out` |
| --- | --- | --- |
| `sf-build framework` | Build Core, Component, Utility and Smart from a ui-source checkout in two byte-identical waves | `<out>/{core,component,utility,smart}` and `build-report.json`: exactly the `--output` that `publish-framework-release.sh` takes |
| `sf-build package` | Build an extension package over the Framework source its `framework.lock.json` pins, in two byte-identical waves, then write its receipt | `<out>/smart/...`, `package-receipt.json`, `package-<name>.tar` |
| `sf-build verify package\|framework` | The two-wave check alone; nothing is laid | (none; `--workspace` keeps the waves) |
| `sf-build receipt` | Write the receipt of a verified package build from its `report.json` | with `--out`, the same layout as `package` |

Later commands, not part of phase 1: `sf-build check <out>` (a consumer gate:
re-hash a served output against its receipt), `sf-build init` (write a
package skeleton and its configuration).

### The configuration file

A product commits `sf-build.config.json` (schema
`simai.sf-build.config.v1`, `schemas/sf-build.config.v1.schema.json`) beside
its package folder or at its repository root:

```json
{
  "$schema": "../vendor/simai/ui-builder/schemas/sf-build.config.v1.schema.json",
  "schema": "simai.sf-build.config.v1",
  "package": {
    "name": "larena",
    "kind": "components",
    "path": "resources/ui",
    "repository": "simai/larena"
  },
  "framework": {
    "source": "../ui-source",
    "ui": "../ui"
  },
  "out": "public/vendor/larena-ui"
}
```

- Relative paths are resolved against the directory of the file.
- Precedence: command-line options and API options, then the environment
  (`SF_BUILD_UI_SOURCE`, `SF_BUILD_UI`, so CI can point at its own
  checkouts), then the file.
- `package.kind` is the extension point of the decision. v1 accepts only
  `components` (`simai.component-package`). `theme`, `utility` and
  `composition-type` are recognised and refused as `KIND_NOT_SUPPORTED`; each
  arrives as a new enum value with its own builder and checks
  (values from tokens only, the shared name grammar, a type manifest), without
  a new configuration schema.
- `sf-build` finds `./sf-build.config.json` in the working directory when
  `--config` is not given, so `npx sf-build package` in a product directory is
  enough.

### Output path

`--out <dir>` / `out` is where the result is laid. The build itself runs in a
workspace (`--workspace`, default a new temporary directory). After both waves
pass and the receipt is written, wave 1 is copied into a staging directory
beside `out`, re-hashed against the report and the receipt, and renamed into
place, so `out` is either the previous result or the complete new one, never
half of each. An existing non-empty `out` is replaced only with `--replace-out`
and only if it holds the marker sf-build lays (`package-receipt.json` or
`build-report.json`); a directory sf-build did not lay is never removed. `out`
may not contain the builder, the package folder, the ui-source checkout or the
workspace. The temporary workspace is removed after a successful run that lays
`out`, and kept after a failure for diagnosis.

### Results, exit codes, progress

With `--json` the CLI prints exactly one JSON document on stdout, the same
object the API resolves to (`simai.sf-build.result.v1`):

```json
{
  "schema": "simai.sf-build.result.v1",
  "command": "package",
  "status": "PASS",
  "exit_code": 0,
  "builder": {"name": "@simai/ui-builder", "version": "1.0.0", "revision": "<commit>", "root": "..."},
  "config": "/abs/larena/sf-build.config.json",
  "kind": "components",
  "package": "larena",
  "components": ["admin-menu", "data-view", "property-view", "table"],
  "output": {"files_count": 0, "manifest_sha256": "...", "archive": "package-larena.tar", "archive_sha256": "..."},
  "package_source": {"repository": "simai/larena", "revision": "<commit>", "path": "resources/ui"},
  "source_revision": "<ui-source commit>",
  "framework": {"source": {"repository": "simai/ui-source", "revision": "<commit>"}, "release": "ui-<12>"},
  "package_reference": "agrees",
  "out": {"root": "/abs/out", "runtime": "/abs/out/smart", "receipt": "/abs/out/package-receipt.json", "archive": "/abs/out/package-larena.tar"},
  "warnings": [],
  "workspace": {"root": "...", "kept": false, "report": null, "receipt": null},
  "error": null
}
```

A failure has `status: "FAIL"`, the exit code, and
`error: {code, message[, details]}`. The API never throws for an expected
failure; it resolves to that object.

| Exit | Meaning | `error.code` |
| --- | --- | --- |
| 0 | built, two waves identical, receipt written, output laid | |
| 1 | the build failed or the waves differ | `BUILD_FAILED`, `NOT_REPRODUCIBLE`, `OUTPUT_MISMATCH` |
| 2 | usage, configuration or output conflict | `USAGE`, `CONFIG_INVALID`, `KIND_NOT_SUPPORTED`, `OUT_CONFLICT`, `WORKSPACE_CONFLICT` |
| 3 | the receipt refused the package (it disagrees with the free release) | `RECEIPT_REFUSED` |
| 4 | environment | `UNSUPPORTED_NODE`, `TOOL_MISSING`, `BUILDER_NOT_A_CHECKOUT` |

Without `--json`, progress lines go to stderr and a short summary to stdout.
The API takes `onProgress(message)` instead.

`warnings` of a package build (and of `verify package`) include every Framework
element a component draws without a relation to the rule that loads it, read
from the component's source (libs/packageRelations.js): a tag in a template,
an element made with `createElement` / `SF.create`, or a descriptor
`component: {type: 'icon-button'}`. Such an element upgrades only when
something else on the page pulled its rule in, so it may render before its
styles arrive. An element the component fetches itself
(`SF.Loader.ensureSmartElementLoaded('sf-radio')`) is not reported. A warning
does not fail the build.

### Node API

```js
const sfBuild = require("<ui-builder>/libs/api");

const result = await sfBuild.buildPackage({
    config: "sf-build.config.json",   // optional; explicit options win
    out: "public/vendor/larena-ui",
    replaceOut: true,
    onProgress: message => console.error(message),
});
if (result.status !== "PASS") throw new Error(`${result.error.code}: ${result.error.message}`);
```

Exports: `buildPackage`, `verifyPackage`, `buildFramework`, `verifyFramework`,
`writeReceipt`, `loadConfig`, `validateConfig`, `EXIT_CODES`,
`RESULT_SCHEMA`, `SfBuildError`. Option names are the camel-case forms of the
CLI options (`packageRoot`, `packageRevision`, `packageRepository`,
`uiSource`, `ui`, `out`, `replaceOut`, `workspace`, `keepWorkspace`,
`requireLegacyCompatibility`), plus `cwd` (base of relative paths) and `env`.

### How products call it

**Larena** (Laravel; the build is a Composer script or a CI step). With the
package in a folder of the repository (for example `resources/ui`) and
`sf-build.config.json` at the repository root:

```json
{
  "scripts": {
    "ui:build": "node \"$SF_BUILDER\"/bin/sf-build.js package --replace-out --json > storage/app/sf-build-result.json"
  }
}
```

```yaml
# CI
- run: git clone --depth 1 --branch <pinned tag> git@github.com:simai/ui-builder.git "$RUNNER_TEMP/ui-builder"
- run: git -C "$RUNNER_TEMP/ui-source" fetch origin "$(jq -r .source.revision resources/ui/framework.lock.json)"
- run: SF_BUILDER="$RUNNER_TEMP/ui-builder" SF_BUILD_UI_SOURCE="$RUNNER_TEMP/ui-source" composer ui:build
```

A PHP build step that wants the result reads it as JSON:

```php
$process = new Symfony\Component\Process\Process(
    ['node', $builder.'/bin/sf-build.js', 'package', '--replace-out', '--json'],
    base_path(),
    ['SF_BUILD_UI_SOURCE' => $uiSource],
);
$process->setTimeout(900)->run();
$result = json_decode($process->getOutput(), true, flags: JSON_THROW_ON_ERROR);
if ($result['status'] !== 'PASS') {
    throw new RuntimeException($result['error']['code'].': '.$result['error']['message']);
}
// $result['out']['runtime'] is served as SF_BOOT_CONFIG.packages.larena.base;
// $result['out']['receipt'] is what Larena's own lock pins.
```

**Docara** calls the Node API from its build when that build runs in Node,
or the CLI as above otherwise. Until Docara has components of its own, it only
consumes the free release and runs no package build.

**The Framework release** keeps calling
`verify-product-reproducibility.cjs` and `publish-framework-release.sh`
unchanged. `sf-build framework --out <dir>` produces the same `--output`
layout for anyone who prefers one command; adopting it in the release route
is a separate, later decision.

### How an external author installs it

| Route | Phase 1 | Notes |
| --- | --- | --- |
| Local path | yes | `node /path/to/ui-builder/bin/sf-build.js ...` from a checkout with `yarn install --frozen-lockfile` done |
| Git clone at a tag or commit | yes | the same; pin the commit, it is recorded in every receipt |
| `npm install github:simai/ui-builder#<commit>` | no | npm strips `.git`; `BUILDER_NOT_A_CHECKOUT` until phase 2 records the package version and integrity instead of the commit |
| `npm install @simai/sf-build` | no | needs publishing (section 6) and phase 2 |

## 3. Phase 1 (this change)

- `bin/sf-build.js`, registered in `package.json` `bin`: `package`,
  `framework`, `verify package|framework`, `receipt`, `--out`,
  `--replace-out`, `--workspace`, `--keep-workspace`, `--config`, `--json`,
  `--help`, `--version`, the exit codes above.
- `libs/api.js`: the functions above, wrapping the accepted scripts as child
  processes. No script, runner or lifecycle changed, so the Framework release
  and the existing package route produce the same bytes as before.
- `libs/sfBuildConfig.js` and `schemas/sf-build.config.v1.schema.json`: the
  configuration and its validation (a validator for the subset of JSON Schema
  the schema uses, reading the schema file itself; no new dependency).
- `tests/sf-build/`: argument handling, configuration validation, and an end
  to end build of a one-component fixture package into a configured output
  path through the CLI and the API (with `--replace-out`, the conflict rules,
  `verify` and `receipt`), and a failing build. `yarn run verify` runs them.

## 4. Phase 2 (proposed)

1. Resolve `postcss` and `postcss-dir-pseudo-class` in
   `postcssLateLogicalFallbacks.js` through the builder dependency runtime
   (the defect in section 1, item 3); prove the Framework output unchanged
   with a two-wave build of the current release source. **Done** (9662cb6).
2. Builder identity without git: record `name`, `version` and the SHA-256 of
   the shipped files when there is no `.git`, so an npm-installed copy works.
3. Port `write-package-receipt.py` to Node, byte-identical receipts and
   archives against the Python one on the fixtures and on Larena's package;
   keep the Python script as a thin alias until no route calls it. The relation
   ids come from a published data file of the release instead of importing
   `ui/scripts/build-framework-registry.py`.
4. The Framework source as data: `framework.source` may name a ui-source
   revision fetched into a cache (`git fetch` of one commit), or a source
   bundle published with each free release, so a product CI needs no sibling
   checkout and an external author needs no private repository access.
5. A shared, read-only, content-addressed dependency runtime cache keyed by the
   lockfile digest, so a product build does not install about 175 MB per run;
   each wave still gets its own copy.
6. `sf-build check <out>`: a consumer gate that re-hashes a served output
   against its receipt.

## 5. Phase 3 (proposed)

New `package.kind` values, each with its own builder and checks, in the order
of the decision. `theme` is built (2026-10-18, `libs/themePackage.js`): a
folder with `framework.lock.json` and `theme.json`
(`{"schema": "simai.framework.theme-source", "schema_version": 1, "color":
"#2e7d32"}`, or `hue` and `chroma`, an optional `selector` and `palettes`
overrides) is built with ui-source's own `src/core/js/theme-palette.js` at the
pinned revision -- the eight palettes of `sf-theme-generator` as the 128
`--sf-<palette>-<tone>` primitives -- twice, compared, and laid as
`theme/theme.css`, `theme/theme.json` and `theme-receipt.json` (schema
`simai.framework.theme-receipt`). `utility` and `composition-type` follow when
a real request arrives. Name checks
against the Framework and other packages extend from the free release's rules
to a package registry when one exists.

## 6. What publishing the tool needs (the owner's decision)

Phase 1 does not change the licence or the package's visibility.
Publishing needs:

- **Licence.** Replace `UNLICENSED` with the chosen licence and add a
  `LICENSE` file. Every shipped dependency's licence must be compatible
  (`subset-font`, `fontverter`, `harfbuzzjs`, `parse5`, and the whole
  webpack toolchain installed into the runtimes).
- **`"private": false`**, and change the matching assertion in
  `scripts/verify-repository-contract.cjs`.
- **Name and scope.** The decision names `@simai/sf-build`; today the package
  is `@simai/ui-builder`, which `verify-repository-contract.cjs` and the icon
  generator id (`@simai/ui-builder/hb-subset@...`) assert. Renaming changes
  `iconSubset.js` output provenance; either keep `@simai/ui-builder` as the
  package name with an `sf-build` binary (what phase 1 does), or rename and
  accept the provenance change through the dependency policy. The `@simai`
  scope must be owned on npm (or a private registry chosen).
- **Shipped files** (`files` in `package.json`): `bin/`, `libs/`,
  `schemas/`, `resources/core/`, the scripts the tool runs
  (`scripts/verify-*-reproducibility.cjs`, `scripts/run-*-product-build.cjs`,
  `scripts/prepare-frozen-dependency-runtime.cjs`,
  `scripts/write-package-receipt.py`), `package.json`, **`yarn.lock`** (the
  frozen runtimes are installed from it), `README.md`, `LICENSE`,
  `CHANGELOG.md`. Not shipped: the root webpack configurations and `*.build.js`,
  `config/`, `.env.example`, `tests/`, the release binders and publish
  scripts (Framework-only), `docs/` (linked from the README instead).
- **Dependency footprint.** Installed: four direct runtime dependencies
  (the icon generator's). At build time: two frozen runtimes of the builder's
  full toolchain per build (about 87 MB each), plus the Framework source's own
  runtime, from the Yarn cache or the network. Requirements: Node.js
  `>=20.19.0`, git, and, until phase 2 item 3, Python 3.
- **Release contract.** A public extension API is a compatibility promise
  (decision): the configuration schema id, the result schema id, the exit
  codes and the receipt schema change only through the changelog and a new
  major version.
