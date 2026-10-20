# Icon subset generator

`ui-builder` owns the single deterministic Material Symbols subset generator
used by SIMAI Framework production builds and by an optional icon service. It
runs the HarfBuzz subsetter WASM of the exact-pinned `harfbuzzjs` dependency;
Python and system font tools are not runtime requirements.

```bash
node bin/sf-icons.js build \
  --font /absolute/path/MaterialSymbolsOutlined.woff2 \
  --icons menu,search,close \
  --family outlined \
  --weight 400 \
  --fill 0 \
  --grade 0 \
  --optical-size 24 \
  --out /absolute/path/to/new-output
```

The command writes a content-addressed WOFF2 file, CSS and an
`sf.icon_subset.v1` manifest. The manifest binds the source font hash, sorted
icon names, family, axes, generator revision, license, provenance and every
output hash. Existing output with different bytes is rejected.

For a production page, omit `--icons` and pass final HTML plus any component
manifests. The planner discovers `.sf-icon` and `<sf-icon>` markup and merges
declared `icons`, `icon_dependencies` and `dynamic_icons` before subsetting:

```bash
node bin/sf-icons.js build \
  --font /exact/MaterialSymbols-Outlined.woff2 \
  --html /build/index.html \
  --manifests /build/components/button.json,/build/components/menu.json \
  --family outlined \
  --out /build/assets/icons
```

Run once per discovered family. Outlined, rounded and sharp requirements are
kept separate, while axis values and late component dependencies are merged
within their family.

The supported families are `outlined`, `rounded` and `sharp`. They are emitted
as separate packets because their source fonts and selectors are different.
Material Symbols `rclt` and `rlig` features are retained for the requested
icons only. The source is subset by glyph id: each requested name is shaped at
the source default and at every requested axis combination, and those glyphs
(including the `.fill` glyphs FILL swaps in), the letters that spell the names
and the ligatures joining them are kept. Subsetting by letters would keep every
ligature the letters spell: 78 names drew 3,465 of the 3,967 icons. Axes are
then instanced on that small font; an axis requested over the source's whole
range is left as it is.

The emitted font is accepted only when:

- `gvar` is present whenever `fvar` declares axes. HarfBuzz drops `gvar`
  silently when instancing a large glyph set runs out of its fixed WASM heap
  (seen from about 2,000 icons), which would leave the axes doing nothing; the
  build fails instead. Request fewer icons or pin every axis.
- every declared axis changes at least one requested icon's outline between
  its minimum and maximum;
- every requested name still shapes to one glyph at each requested axis
  combination;
- the font draws no more icons (distinct ligature glyphs) than names were
  requested. The CLI reports the count as `drawn_icons`.

Identical inputs must produce identical bytes on macOS, Linux and CI.

Production consumers should preload the initial packet, then pass its manifest
to Framework Loader. A late icon is handled by a new cumulative packet or an
exact local full-font fallback. The online service is an optional accelerator,
not a correctness dependency.

An existing `icons.simai.io` deployment can keep its `/ms/css` API by calling
`buildLegacyIconSubsetResponse` from `libs/iconSubsetServiceAdapter.js`. The
adapter parses the legacy query, delegates to the same generator and returns
CSS plus the `X-SIMAI-Font-Manifest` header and WOFF2 bytes. It is an adapter,
not a second generator or a second icon registry.
