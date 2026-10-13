# Secret scan before publication (2026-10-13)

- Tool: gitleaks 8.30.1, default rule set.
- Command: `gitleaks git --log-opts="--all" --redact --report-format json --report-path <report> .`
- Scope: every commit on every ref, 54 commits, ~1.04 MB, at HEAD f88ecb256189.
- Result: no leaks found (exit 0).
- File names: no `.env`, key, certificate, credential or cookie files in the history.
- Third-party files: none vendored; no fonts or images in the history. Build
  dependencies come from the npm registry through `yarn.lock`.
