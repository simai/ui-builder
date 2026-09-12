# Product runner reference

Product runners build one SIMAI Framework product into a new output root and
write machine-readable diagnostics. They are intended for controlled
automation and reproducibility checks.

## Common path contract

Every path argument must be absolute:

1. `builderRoot`: the `ui-builder` checkout;
2. `sourceRoot`: the `src` directory of an exact `ui-source` checkout;
3. `outputRoot`: a path that does not exist before the run;
4. `diagnosticsPath`: the JSON diagnostics file to create.

The output root must be outside the source tree. Symbolic links, escaping paths,
collisions, or an existing output root fail closed.

## Dependency runtimes

Set both variables to dependency roots prepared from frozen lockfiles:

```bash
export SF_BUILDER_DEPENDENCY_ROOT=/absolute/path/to/builder-runtime
export SF_SOURCE_DEPENDENCY_ROOT=/absolute/path/to/source-runtime
```

Use `scripts/prepare-frozen-dependency-runtime.cjs` to create those roots. The
two-wave verifier performs this step automatically.

## Core

```bash
node scripts/run-core-product-build.cjs \
  /absolute/path/to/ui-builder \
  /absolute/path/to/ui-loader/src \
  /absolute/path/to/new-core-output \
  /absolute/path/to/core-diagnostics.json
```

## Component or Utility

The first argument must be `component` or `utility`:

```bash
node scripts/run-component-utility-product-build.cjs \
  component \
  /absolute/path/to/ui-builder \
  /absolute/path/to/ui-loader/src \
  /absolute/path/to/new-component-output \
  /absolute/path/to/component-diagnostics.json
```

For a memory-bounded Utility build, set
`SF_PRODUCT_ENTRY_FILTER_MANIFEST` to an absolute regular JSON file:

```json
{
  "schemaVersion": 1,
  "target": "utility",
  "entryKeys": ["utility/gap/default", "utility/padding/default"]
}
```

The lifecycle validates every requested key against the complete source plan,
then compiles and packages only those entries. Component builds reject the
filter. Multiple shard outputs may be merged only when colliding paths are
byte-identical.

## Smart

```bash
node scripts/run-smart-product-build.cjs \
  /absolute/path/to/ui-builder \
  /absolute/path/to/ui-loader/src \
  /absolute/path/to/new-smart-output \
  /absolute/path/to/smart-diagnostics.json
```

## Diagnostics contract

Invocation errors are written to standard error as JSON with `status: 2` and a
stable error code. A completed product run writes the diagnostics file passed on
the command line. Acceptance requires a zero status and an empty diagnostics
array; a process exit code alone is not sufficient evidence.

## Legacy compatibility materialization

Legacy compatibility is enabled only when all three variables are present and
consistent:

- `SF_LEGACY_COMPATIBILITY_ROOT`;
- `SF_LEGACY_COMPATIBILITY_MANIFEST`;
- `SF_LEGACY_COMPATIBILITY_REVISION`.

A partial or mismatched binding fails closed.

The root may be a read-only corpus assembled from multiple exact generated
revisions. Every manifest record is still verified by path, size, and SHA-256
before it can be materialized. Component and Smart compatibility records are
copied only into their matching product outputs. Records are restricted to the
generated `core/`, `component/`, and `smart/` namespaces; paths outside those
namespaces, path escapes, digest drift, and non-identical output collisions
fail closed.

For a two-wave release check that is required to retain these assets, invoke
`verify-product-reproducibility.cjs` with
`--require-legacy-compatibility`. This prevents an accidental source-only run
from being accepted as evidence for a compatibility-bound release and records
the validated binding in `report.json`.
