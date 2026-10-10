# Publishing a SIMAI Framework Pro release

SIMAI Framework Pro is four Smart components (`sf-table`, `sf-data-view`,
`sf-property-view`, `sf-admin-menu`) whose source is the private
`ui-source-pro` and whose distribution is the private `ui-pro`. They run on the
free Framework and are loaded as its `pro` component package
(ui-source `docs/developer/component-packages.md`).

A Pro release is **one `ui-pro` build commit** that wrote `smart/`. Its id is
`pro-<first 12 hex of that commit>`, and its contract is
`ui-pro/contracts/releases/pro-<12>.lock.json`. A Pro release always names the
free release it was built and tested against, so the free release comes
first (`framework-release.md`).

`scripts/publish-pro-release.sh` is the route. It never pushes.

## The overlay

The Pro components import the free Framework by relative path
(`../../core/js/smart-base`, `../helpers/dom`, `../field-renderers/index.js`).
`ui-source-pro/framework.lock.json` pins the ui-source revision they build
against. `libs/proProduct.js` (`materializeProOverlay`) lays ui-source at that
revision and ui-source-pro at a commit over it, both from `git archive`, never
from a working tree, and refuses a Pro file that would replace a ui-source one.
Every import resolves unchanged.

## Build

```bash
node scripts/verify-pro-reproducibility.cjs \
  /absolute/ui-source-pro /absolute/ui-source /absolute/new/workspace \
  [--pro-revision <commit, default HEAD>]
```

Each wave lays its own overlay, prepares frozen dependency runtimes for the
builder and for the overlay (ui-source's `package.json` and `yarn.lock`) and
runs `scripts/run-pro-product-build.cjs` (`product-runners.md`). The two
waves must be byte-identical. `wave-1/output/pro/smart` holds exactly the four
Pro folders and `rule.js` (+ `.gz`); `report.json` records the Pro and
ui-source revisions and the output's hash.

`smart/rule.js` is generated from the four `rule.js` files: each is run in a
sandbox, must write exactly its own `cl-<folder>` rule as plain data (no
`package` field, no RegExp), and the rules are written, keys sorted, as one
`SF.RuleLoader.registerPackage("pro", {rules})` call. The Loader stamps
`package: 'pro'` on them when the page declares the package.

Test before publishing: in ui-source-pro, `node scripts/test.mjs` (the Pro
suite and the free suite's cross-cutting checks, in the overlay) and
`node scripts/run-browser-probes.mjs <free wave-1/output> <pro wave-1/output/pro>`.

## Inputs

- The workspace's `report.json` (status PASS).
- A clean `ui-pro` checkout.
- The `ui-source-pro` and `ui-source` checkouts holding the built revisions.
- A `ui` checkout holding the free release `ui-<12>`, built from the same
  ui-source revision Pro pins.

```bash
scripts/publish-pro-release.sh \
  --report /absolute/workspace/report.json \
  --pro ../ui-pro --pro-source ../ui-source-pro --source ../ui-source \
  --ui ../ui --framework ui-<12> \
  --subject "what the release changes"
```

`--builder-revision`, `--work` and `--trailer` work as in
`publish-framework-release.sh`.

## Steps

1. **Check the build and the free release** (`bind-pro-release.py output`,
   `package`). The output is the one the report hashed, and is the four
   folders and `rule.js`. `ui-<12>` exists, and its package reference
   `ui/contracts/packages/pro.package.json` agrees with the Pro rules: the same
   rules, tags and folders, none of the folders in its `distr/smart`, and each
   entry's `requires` equal to its rule's relations as registry ids (a Pro rule
   by its Pro id, any other by the free registry's mapping over the release's
   `rule.json`). The free registry walks a recipe through those `requires`, so
   they must be true.
2. **Lay and commit the build**: `rsync --delete` into `ui-pro/smart`, commit
   `Build: <subject>`. That commit is the release.
3. **Receipt, owner manifest, lock** (`receipt`, `owners`, `reference`). The
   receipt refuses a Pro build over a ui-source revision other than the one
   `ui-<12>` was built from. The owner manifest
   (`ui-pro/contracts/owners/smart-component.manifest.json`, owner
   `simai/ui-pro`) has one entry per component: runtime fields (`rule_name`,
   `tags`, `asset_paths` under `css/`, `js/`, `template/`, `declared`,
   `requires`) are derived from the release; curated fields (title,
   lifecycle, readiness, `curated_for`) are kept from the manifest already in
   ui-pro, else seeded from the free Smart owner manifest at the build commit
   of `ui-<12>` (which still held `smart.admin-menu` and `smart.data-view`),
   else defaulted (`discoverable`, not suggested). It is validated by ui's own
   owner-manifest envelope check.
4. **Pro release gate** (`check`): every lock validates; each names the build
   commit that last wrote `smart` and git agrees with its hashes; every
   required file is in the release; the owner manifest is bound to the newest
   release and its assets exist; each lock's `requires.framework` is a ui
   release built from `requires.source`. Red: the bind stays uncommitted in
   ui-pro for inspection.
5. **Bind commit**: `Bind the Pro release pro-<12>`.

## The lock

```json
{
  "schema_id": "simai.framework.pro-release-lock",
  "schema_version": 1,
  "compatibility_id": "pro-<R12>",
  "status": "bounded",
  "profile": "plain-assets-v1",
  "package": "pro",
  "runtime_sources": {
    "smart": {"owner": "simai/ui-pro", "revision": "<R>", "commit": "<writer of smart>", "runtime_path": "smart", "tree": "...", "runtime_tree": "...", "archive_sha256": "...", "tag": null, "tag_object": null}
  },
  "required_files": ["smart/rule.js", "smart/<folder>/js/<folder>.js", "smart/<folder>/css/<folder>.css"],
  "requires": {"framework": "ui-<12>", "source": "<ui-source revision>"},
  "build_inputs": {"source": {...}, "pro_source": {...}, "builder": {...}},
  "inventory": {"smart_components": 4, "rules": 4},
  "exclusions": [],
  "claims": {"full_compatible": false, "production_ready": false, "all_items_ready": false}
}
```

It mirrors the free lock v2 for its one tree. `required_files` are the files a
consumer must find under the mount: the rule file, and each component's
script and, when its rule declares one, stylesheet.

## Consumers

A page serves the Pro release beside the free release it requires and
declares `SF_BOOT_CONFIG.packages.pro = {base: '<mount>/smart'}`; the Loader
fetches `<base>/rule.js` itself. Serve each release under its own path: a
package's files share Core's cache version.

## Moving Pro to a new free release

Release the free Framework first. Then point `ui-source-pro/framework.lock.json`
at the ui-source revision that release was built from, run the Pro tests and
probes, commit, build and publish with `--framework` naming that release. If
the Pro rules' relations changed, the package reference in `ui` must say so in
that free release, or step 1 refuses.
