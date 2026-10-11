# UI Builder documentation

This documentation is for developers who build, integrate, or maintain SIMAI
Framework. `ui-builder` has no end-user runtime interface; it is build tooling
for the framework repositories.

## Choose a path

### Set up and verify the builder

1. [Getting started](developer/getting-started.md)
2. [Product runner reference](developer/product-runners.md)
3. [Dependency policy](developer/dependency-policy.md)

### Understand or maintain the pipeline

1. [Architecture and ownership](developer/architecture.md)
2. [sf-build: one build tool for the Framework and its packages](developer/architecture-sf-build.md)
3. [Product runner reference](developer/product-runners.md)
4. [Dependency policy](developer/dependency-policy.md)

### Publish a release

- [Publishing a Framework release](developer/framework-release.md)
- [Product component packages](developer/product-packages.md): a product's own
  Smart components, built over a pinned Framework revision, with a receipt
- [Publishing a SIMAI Framework Pro release](developer/pro-release.md)
  (superseded by product component packages)

### Review the migration provenance

- [Migration from the legacy `sf5.webpack` repository](developer/migration-from-sf5-webpack.md)

## Documentation contract

All tracked documentation, code comments, CLI messages, issue and pull request
text, and commit subjects must be written in English. Technical identifiers and
historical repository names are preserved where accuracy requires them.

The brand is always written as `SIMAI` in prose. Lowercase `simai` is reserved
for technical identifiers, package scopes, repository paths, and URLs.
