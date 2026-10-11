# Publishing a Framework release

A SIMAI Framework release is **one `ui` build commit**. Its id is
`ui-<first 12 hex of that commit>`, and its contract is the release lock v2
`ui/contracts/releases/ui-<12>.lock.json` (schema
`ui/contracts/schema/framework-release-lock.v2.schema.json`).

Core, rules, components, utilities and Smart components are all published in
`ui/distr` (`core`, `rule`, `component`, `utility`, `smart`). While consumers
still read Smart from `ui-smart`, the same Smart bytes are also laid into
`ui-smart/smart` (the *mirror*), and the lock records it.

`scripts/publish-framework-release.sh` is the route. It never pushes.

## Inputs

- Build output verified by `scripts/verify-product-reproducibility.cjs` (two
  byte-identical waves); `wave-1/output` holds `core/core`, `core/rule`,
  `component/component`, `utility/utility` and `smart/smart`.
- Clean checkouts of `ui`, `ui-smart` (the mirror) and the `ui-source`
  revision that was built.
- A changelog entry for `ui/CHANGELOG.md`, inserted under `[Unreleased]` in the
  section named by `--changelog-section`.

```bash
scripts/publish-framework-release.sh \
  --output /absolute/repro/wave-1/output \
  --ui ../ui --mirror ../ui-smart --source ../ui-source \
  --subject "what the release changes" \
  --changelog-entry /absolute/entry.md --changelog-section "<heading under [Unreleased]>"
```

`--builder-revision` names the `ui-builder` commit that built the output when it
is not `HEAD`. `--trailer` appends a closing paragraph (for example a
`Co-Authored-By:` line) to every commit message. `--no-mirror` publishes
without `ui-smart` once no consumer reads it.

## Steps

1. **Lay the output** into `ui/distr/{core,rule,component,utility,smart}` and
   `ui-smart/smart` (`rsync --delete`; nothing else in either repository is
   touched).
2. **Commit the build.** The `ui` commit (`Build: <subject>`) is the release.
   `ui-smart` gets a build commit only when its Smart bytes moved.
3. **Write the receipt** (`scripts/write-release-receipt.py`). Each tree is
   named by the build commit that last wrote it as of the release: `distr` is
   always the release itself; `distr/smart` is the release, or an earlier build
   commit if this release did not change a Smart byte. The mirror is named the
   same way in `ui-smart`.
4. **Bind the owner manifests** (`bind-generated-runtime-contracts.py --phase
   owners`, with `--smart-root` equal to `--ui-root`). The Smart owner manifest
   is `ui/contracts/owners/smart-component.manifest.json` (owner `simai/ui`,
   assets `simai/ui@<rev>:distr/smart/...`); on the first v2 release it is
   seeded from the mirror's. The mirror's own manifest is rebound to the mirror
   commit and committed in `ui-smart`.
   Components a package provides (`ui/distr/core/contracts/packages/*.package.json`, source ui-source `src/core/contracts/packages/`;
   SIMAI Framework Pro is the first) leave both Smart owner manifests here,
   in the release that stops shipping their folders: the binder drops their
   entries and lowers `inventory.expected`, and refuses if a provided folder is
   still in `distr/smart` or the mirror.
5. **Write the release lock** (`--phase reference`): `ui-<12>.lock.json`, and,
   while mirrored, the v1 alias `ui-<12>-smart-<12>.lock.json` that v1 readers
   resolve (ui-admin's pin finds a release by the commits it pins).
6. **Run `ui/scripts/release-gate.sh`.** It builds and checks the registry,
   runs the registry suite and `check-release-locks.py` (each tree named by its
   writer, mirror byte-identical, alias present and in agreement). When it is
   red the route stops and the bind stays uncommitted in `ui` for inspection.
7. **Changelog and the bind commit** `Bind the registry to the release ui-<12>`.

## The lock

```json
{
  "schema_version": 2,
  "compatibility_id": "ui-<R12>",
  "runtime_sources": {
    "core":  { "owner": "simai/ui", "revision": "<R>", "commit": "<R>", "runtime_path": "distr", ... },
    "smart": { "owner": "simai/ui", "revision": "<R>", "commit": "<writer of distr/smart>", "runtime_path": "distr/smart", ... }
  },
  "mirror": { "owner": "simai/ui-smart", "commit": "<M>", "runtime_path": "smart", "runtime_tree": "<same as smart>", "mirrors": "smart", ... },
  "pair": "ui-<R12>-smart-<M12>"
}
```

`revision` is the release, the same for both trees. `commit`, `tree`,
`runtime_tree` and `archive_sha256` describe the commit that wrote each tree, as
in v1. `mirror` and `pair` are present only while `ui-smart` is mirrored.

## Product component packages

A product's own Smart components are built over the ui-source revision a free
release was built from, and pinned by a package receipt that names that
release: `docs/developer/product-packages.md`. Release the free Framework
first. (SIMAI Framework Pro, released into `ui-pro`, is superseded:
`docs/developer/pro-release.md`.)

## Rollback

Stop laying `distr/smart`: publish with the v1 binder layout (`--smart-root`
pointing at `ui-smart`). Already written v2 locks stay valid history.
