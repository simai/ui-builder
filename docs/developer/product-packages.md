# Product component packages

A **product component package** is a set of Smart components that belongs to a
product, not to SIMAI Framework. Larena keeps its data table, data view,
property view and admin menu this way; Docara will keep its own components the
same way when it has them. Universal components stay in the Framework
(`simai/ui-source`, released in `simai/ui`).

A package:

- lives in a folder of the product's own UI repository, laid out like
  ui-source, and pins the ui-source revision it is built on;
- is built by ui-builder over that revision, twice, byte-identically;
- ships **inside the product's own distribution** (no separate distribution
  repository, no built bytes in git): the product build runs ui-builder and
  keeps the output;
- is loaded by the free Framework's Loader as a component package named after
  the product: `SF_BOOT_CONFIG.packages.<name>.base` (ui-source
  `docs/developer/component-packages.md`);
- is pinned by its consumers through a **package receipt**, not through a
  release lock.

This replaces SIMAI Framework Pro (`pro-release.md`, superseded).

## The package folder

The folder may be the root of a repository or any subdirectory of a larger one
(for example a `resources/ui` folder of a product repository):

```text
<package path>/
  framework.lock.json        the ui-source revision the package builds on
  src/smart/<folder>/        one folder per component, as in ui-source src/smart
    index.js                 the entry
    rule.js                  writes SF.RuleLoader['cl-<folder>']
    scss/ template/ ...      as in ui-source
  src/smart/<helper>/        optional: a folder without rule.js is laid, not built
  package.json               the package's licence: "license" (required)
  tests/                     the package's tests (laid into the overlay)
  docs/                      optional, laid into the overlay
```

Only `src/`, `tests/` and `docs/` of the folder are built, and the `license`
of its `package.json` is recorded in the receipt; everything else in the
repository is ignored.

`framework.lock.json`:

```json
{
  "schema": "simai.framework.product-package-source-lock.v1",
  "package": "larena",
  "source": {
    "repository": "simai/ui-source",
    "revision": "<full ui-source commit>"
  }
}
```

`package` is optional; when present it must equal the `--package` the build is
run with. The SIMAI Framework Pro schema `simai.framework-pro.source-lock.v1`
is still accepted, so the four components can move without touching their lock.

### Rules for components

- The folder name is the component name: `[a-z][a-z0-9-]*`.
- `rule.js` writes exactly one rule, `SF.RuleLoader['cl-<folder>']`, as plain
  data (no RegExp, no function, no string evaluation), with `type: 'smart'`,
  non-empty `tags` and **no `package` field**: the Loader stamps the package
  when a page declares it. No two rules may claim the same element.
- The components import the free Framework by relative path
  (`../../core/js/smart-base`, `../helpers/dom`,
  `../field-renderers/index.js`), exactly as ui-source's own components do.
- A package file may not replace a ui-source file: a package adds to the
  Framework, it does not shadow it.
- **A package carries no element layer of its own.** lit, the Smart base and
  the element layer (`element-manifest`, `aliases`, `alias-table`,
  `host-port`, `deprecations`, `page-actions`, `layer-stack`,
  `open-surface-mark`, `instance-path`, `page-language`, `position`,
  `control-spacing`) come from the page's shared runtime: an import of one of
  them becomes `SF.runtimeModule(id, abi)` (`libs/sharedRuntime.js`), only
  for the ids the pinned ui-source's own runtime hands out
  (`core/js/runtime.js`), with the runtime ABI of its
  `core/contracts/shared-runtime.v1.json`. The page runs the release's
  runtime; a runtime of another ABI refuses the bundle loudly. ui-source
  `docs/developer/shared-runtime.md` describes the runtime.
- A bundle embeds only the keys of its `component.json` the runtime reads
  (the contract's `component_manifest_keys`, `libs/componentManifestEmbed.js`);
  a package component's code that reads another key off its manifest must
  get it added there in ui-source. Inside those keys it drops the contract's
  `component_manifest_drop` (`summary`, `examples`, the tools' `x-` words)
  from two levels down: a package component reads none of them at runtime
  and names no member (a carried field, a `with` parameter) like one.
- A component that needs another Smart element on the page asks for it by
  tag; it does not import that element's `index.js` (the Loader defines it
  from its own bundle). An import puts a second copy of the element, and of
  its sheet, in the importer's bundle.

## The overlay

ui-builder lays out ui-source at the pinned revision and the package's `src/`,
`tests/` and `docs/` at a commit over it (`libs/packageProduct.js`,
`materializePackageOverlay`). Both come from git (`git archive`), never from a
working tree, so the overlay is exactly two commits. Every relative import
resolves unchanged, and the package's tests read the same paths ui-source's
tests do. `wave-1/overlay` of a build is that tree.

## Building and verifying

```bash
node /absolute/ui-builder/scripts/verify-package-reproducibility.cjs \
  /absolute/product-ui/resources/ui \
  /absolute/ui-source \
  /absolute/new/workspace \
  --package larena \
  [--package-revision <commit, default HEAD>]
```

The first argument is any directory inside a git checkout: the repository and
the path inside it are worked out from it. Equivalently, name the repository
and the path:

```bash
node /absolute/ui-builder/scripts/verify-package-reproducibility.cjs \
  /absolute/ui-source /absolute/new/workspace \
  --package larena \
  --package-source /absolute/product-ui --package-path resources/ui \
  [--package-revision <commit>] [--package-repository simai/larena-ui]
```

`--package-repository` overrides the repository id recorded in the receipt
(default: `owner/name` of the `origin` GitHub remote). The ui-source checkout
must hold the pinned commit. The workspace must not exist and must lie outside
the builder, the package repository and ui-source.

Each wave lays its own overlay, prepares frozen dependency runtimes for the
builder and for the overlay (ui-source's `package.json` and `yarn.lock`) and
runs `scripts/run-package-product-build.cjs` (`product-runners.md`). The two
waves must be byte-identical. The result:

```text
<workspace>/
  report.json                         PASS/FAIL, revisions, manifest digest
  wave-1/output/package/<name>/smart/
    <folder>/js/<folder>.js (+ .gz)   one folder per component
    <folder>/css/<folder>.css (+ .gz) when the component has styles
    rule.js (+ .gz)                   the package rule file
  wave-1/overlay/                     the tree the package's tests run in
```

`smart/rule.js` is generated from the components' `rule.js` files: each runs
in a sandbox, and the rules are written, keys sorted, as one call:

```js
SF.RuleLoader.registerPackage("larena", {
  rules: { "cl-admin-menu": {...}, "cl-table": {...} },
});
```

Run the package's own tests in `wave-1/overlay` (or in an overlay the package
lays itself) and its browser probes against the free build of the pinned
ui-source revision plus `wave-1/output/package/<name>` before using the build.

## The receipt

```bash
python3 /absolute/ui-builder/scripts/write-package-receipt.py \
  --report /absolute/new/workspace/report.json \
  --ui /absolute/ui
```

It refuses a report that did not pass, an output that is not the one the
report hashed, and a rule file of another package. It writes, beside the
report, `package-receipt.json` and `package-<name>.tar`, a deterministic tar
of the output (`ustar`, entries sorted, owner `0:0`, mtime `0`, modes
`0755`/`0644`):

```json
{
  "schema_id": "simai.framework.product-package-receipt",
  "schema_version": 1,
  "package": "larena",
  "loader": {"declaration": "SF_BOOT_CONFIG.packages.larena.base", "base": "<mount>/smart", "rule_file": "smart/rule.js"},
  "package_source": {"repository": "simai/larena-ui", "revision": "<commit>", "path": "resources/ui", "tree": "<git tree of the path>"},
  "licence": {"ref": "Apache-2.0"},
  "framework": {"source": {"repository": "simai/ui-source", "revision": "<pinned>"}, "release": "ui-<12>",
                "runtime": {"abi": 1, "modules": {"element-manifest": ["elementFromManifest"], "lit": ["html", "nothing"]}},
                "runtime_check": {"contract": "distr/core/contracts/shared-runtime.v1.json", "status": "agrees | not-published"}},
  "builder": {"repository": "simai/ui-builder", "revision": "<commit>", "clean": true},
  "node": "v20.19.5",
  "output": {"runtime_path": "smart", "files_count": 0, "manifest_sha256": "...", "archive": "package-larena.tar", "archive_sha256": "...", "archive_format": "..."},
  "required_files": [{"path": "smart/rule.js", "sha256": "...", "size": 0}, {"path": "smart/<folder>/js/<folder>.js", "...": "..."}],
  "inventory": {"components": 4, "rules": 4, "elements": [{"element": "sf-table", "rule_name": "cl-table", "folder": "table", "js": true, "css": true, "relations": ["..."]}]},
  "package_reference": {"path": "distr/core/contracts/packages/larena.package.json", "release": "ui-<12>", "status": "agrees | absent | no-release | not-checked"},
  "files": [{"path": "smart/...", "sha256": "...", "size": 0}],
  "claims": {"production_ready": false}
}
```

- `framework.release` is the free release built from the pinned ui-source
  revision, resolved from `ui/contracts/releases/ui-<12>.lock.json`
  (`build_inputs.source.commit`); `null` when there is none yet, or when no
  `--ui` is given. The package must be served beside that release.
- `framework.runtime` is what the package's bundles ask the page's shared
  runtime for: the runtime ABI of the pinned ui-source (`null` before it had
  one) and, per module id, the names imported from it (`*` for a namespace).
  The build writes it (`<diagnostics>.runtime.json`) and the reproducibility
  report carries it; `null` when the builder predates it (2026-10-28). With
  `--ui`, `framework.runtime_check` compares it with the release's
  `distr/core/contracts/shared-runtime.v1.json`: another ABI, a module the
  release does not hand out, a name it does not export, or no reported usage
  against a release that publishes the contract refuse the receipt.
  `not-published`: the release is older than the contract and the package
  asked without an ABI. Additive fields; `schema_version` stays `1`.
- `licence.ref` is the `license` field of the package folder's
  `package.json` at `package_source.revision`, as written there: an SPDX
  license id (`Apache-2.0`), a `LicenseRef-...`, or an SPDX expression
  (`PolyForm-Small-Business-1.0.0 OR LicenseRef-SIMAI-Commercial`). A package
  must declare its licence: without a `package.json`, without `license`, or
  with a value that is not an SPDX expression (npm's `UNLICENSED`,
  `SEE LICENSE IN <file>`, the old `{type}` object), the receipt is refused.
  The licence lives in the receipt only; the output and its archive do not
  change. The receipt records what the package declares, nothing more: which
  terms a consumer takes it under (a tier, a commercial grant) is the
  consumer's own data. Receipts written before this field have no `licence`;
  a reader of a v1 receipt treats its absence as "not recorded" rather than
  as any licence. The field is additive, so `schema_version` stays `1`.
- `required_files` are the files a consumer must find under the mount: the
  rule file, and each component's script and, when its rule declares one,
  stylesheet.
- `manifest_sha256` is the SHA-256 of the compact JSON list of
  `{path, sha256, size}` of every output file (`files`), in the order the
  builder walks the tree, followed by a newline.

With `--ui`, the receipt also checks the package against the free release:
every relation of a package rule names a rule of the package or of the
release's `distr/rule/rule.json`, and no package element is also a free one.
When the release publishes a **package reference** for this name
(`distr/core/contracts/packages/<name>.package.json`), it must agree with the
package rules: the same rules, elements and folders, none of the folders in the
release's `distr/smart`, and each entry's `requires` equal to its rule's
relations as registry ids. A missing reference is a warning
(`package_reference.status: absent`), not a failure.

## What a product build runs

`sf-build package` runs the steps below and lays the result into an output
path of the product's choice (`--out`, or `out` in `sf-build.config.json`):
`<out>/smart/...`, `package-receipt.json` and `package-<name>.tar`
(`architecture-sf-build.md`). The scripts themselves:

```bash
node <ui-builder>/scripts/verify-package-reproducibility.cjs \
  <product-ui>/<package path> <ui-source> <new workspace> --package <name> \
  --package-revision <product-ui commit>
python3 <ui-builder>/scripts/write-package-receipt.py \
  --report <new workspace>/report.json --ui <ui>
```

Then it copies `<workspace>/wave-1/output/package/<name>/smart` into its own
distribution (or unpacks `package-<name>.tar`), and records the receipt.

## Consuming a package

The consumer serves the package's `smart/` beside the free release it
requires, under its own path (a package's files share Core's cache version, so
a new package build gets a new path), and declares it:

```js
window.sfPath = '/assets/ui/distr/';
window.SF_BOOT_CONFIG = {packages: {larena: {base: '/assets/larena-ui/smart'}}};
```

The Loader fetches `<base>/rule.js` itself. The consumer's own lock pins the
receipt: `package`, `package_source.revision`, `licence.ref`, `framework.release`,
`output.manifest_sha256` (or `output.archive_sha256`) and the `required_files`
hashes, and its gate checks the served files against them.

## Moving a package to a new free release

Release the free Framework first. Then point the package's
`framework.lock.json` at the ui-source revision that release was built from,
run the package's tests and probes, commit, build, and write the receipt with
`--ui`: `framework.release` names the new release. If the release publishes a
package reference for the name and the package rules' relations changed, the
reference must say so in that free release, or the receipt refuses.

## SIMAI Framework Pro

SIMAI Framework Pro is dropped; its four components move into Larena's package.
Until they move, `run-pro-product-build.cjs`, `verify-pro-reproducibility.cjs`,
`bind-pro-release.py` and `publish-pro-release.sh` are kept unchanged and still
build and publish `ui-source-pro` into `ui-pro` (`pro-release.md`). They are
deprecated: `libs/proProduct.js` is now this package build with the name
`pro`, the four fixed folders and Pro's own rule-file header, so a Pro build
stays byte-identical to the one that made `pro-57f4aa1b9da1`. They are removed
after `ui-source-pro` and `ui-pro` are archived.
