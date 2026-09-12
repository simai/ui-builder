# Contributing

Thank you for improving SIMAI Framework UI Builder.

## Language

English is the project language. Use English for:

- documentation and Markdown files;
- code comments, log messages, diagnostics, and CLI output;
- issue and pull request titles and descriptions;
- commit subjects and bodies;
- GitHub repository metadata and workflow labels.

The brand name is always written as `SIMAI`; mixed-case variants are incorrect.
Lowercase `simai` is used only when it is part of a technical identifier,
package scope, repository path, or URL, such as `@simai/ui-builder` and
`simai/ui-source`.

Technical identifiers, external product names, and historical repository names
may remain unchanged when translation would reduce accuracy or traceability.

## Before changing the builder

Identify the ownership boundary first:

- framework SCSS, JavaScript, and templates belong in `simai/ui-source`;
- build planning, Webpack configuration, lifecycle, and packaging belong here;
- `simai/ui` and `simai/ui-smart` are generated distributions and are not
  source repositories.

Do not combine an output-producing dependency update with generated
distribution publication.

## Development workflow

1. Create a focused branch from `main`.
2. Install with the frozen lockfile.
3. Make the smallest compatible change.
4. Update documentation when commands, behavior, architecture, or maintenance
   policy changes.
5. Run `yarn run verify`.
6. For output-affecting changes, run two full product waves against an exact
   `ui-loader` revision and classify every output difference.
7. Submit the exact commit and Git tree for independent acceptance when the
   change affects generated output.

Use imperative English commit subjects, for example:

```text
Document the product runner contract
Preserve logical CSS declarations in PostCSS output
Reject existing product output roots
```

## Pull request checklist

- [ ] The change is in the owning repository.
- [ ] Public text and commit messages are in English.
- [ ] `yarn run verify` passes on the required Node.js version.
- [ ] Documentation and changelog impact is addressed.
- [ ] No `.env`, credentials, generated distributions, or temporary evidence is
      committed.
- [ ] Output differences are classified when build behavior changes.
- [ ] The change does not claim complete RTL readiness without component-matrix
      acceptance.
