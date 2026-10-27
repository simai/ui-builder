# Usage records and reconcile (simai.linkage)

Standard `simai.linkage` 1.0.0 (requirements 11-16) asks every consumer of
SIMAI Framework units -- the Figma UI kit, a documentation site, a product, a
customer project, an example -- to keep a **usage record** and to compare it
with a release's **unit inventory** before it publishes. `ui-builder` carries
the format and the command:

- `schemas/simai.framework.unit-usage.v1.schema.json` -- the usage record;
- `schemas/simai.framework.unit-reconcile-report.v1.schema.json` -- the report;
- `scripts/reconcile.mjs` (bin `sf-reconcile`) -- `reconcile` and `record`.

The inventory (`simai.framework.unit-inventory` v1) and the change report
(`simai.framework.unit-change-report` v1) are ui-source's formats
(`src/core/contracts/unit-*.v1.schema.json`); the Framework release route
writes them to `simai/ui` as `contracts/releases/ui-<12>.inventory.json` and
`ui-<12>.changes.json` (see [Publishing a Framework release](framework-release.md)).

The script needs Node.js 20 or newer and nothing else: no install, no
ui-source checkout. A project can run it from a checkout of `ui-builder`, as
the package's `sf-reconcile` bin, or as the single file fetched from GitHub.

## The usage record

```json
{
  "schema": "simai.framework.unit-usage",
  "schema_version": 1,
  "consumer": { "id": "ui-kit", "kind": "figma-kit" },
  "sources": [
    { "source": "simai/ui-source", "release": "ui-9e143bcd37c1", "brought_up_on": "2026-10-27" }
  ],
  "places": [
    {
      "place": "figma:12:34 Button/primary",
      "units": [
        { "id": "smart.button", "version": "1.1.0", "content_sha256": "<64 hex>" }
      ]
    }
  ]
}
```

- `consumer.kind` is one of `figma-kit`, `docs`, `product`, `project`,
  `example`, `other`.
- `sources[]` names every source the consumer takes units from and the release
  it was last brought up to (`release`, or `null` before it was). `revision`
  and `brought_up_on` are optional; `brought_up_on` places journal entries
  that carry no unit version (see below).
- `places[].place` is a free-form locator: a Figma node id or component key, a
  documentation page path, a project file or screen.
- `places[].units[]` gives the id, version and content hash the place was made
  against, as the inventory of the record's release gave them. A unit may name
  its `source` when the record has several sources and the id alone does not
  tell.
- Foundations -- token sets, fonts, icon sets -- are **not** listed by hand:
  reconcile follows the inventory's dependencies.

The record lives with the consumer; the source never reads it.

### Starting a record

```sh
node scripts/reconcile.mjs record --from-inventory <inventory> \
  --units smart.button,utility.text-align --place "figma:12:34 Button/primary" \
  --consumer ui-kit --kind figma-kit --brought-up-on 2026-10-27 --out usage.json

node scripts/reconcile.mjs record --from-inventory <inventory> \
  --units font.inter --place "docs:/fonts.md" --add-to usage.json --out usage.json
```

`record` copies each unit's version and hash from the inventory. `--add-to`
adds a place to an existing record (a place with the same locator is
replaced); a record brought up to another release of the same source is
refused -- reconcile and bring it up first.

## Reconcile

```sh
node scripts/reconcile.mjs --record usage.json \
  --inventory ui-<12> --releases ../ui/contracts/releases \
  --journal ../ui-source/contracts/changes/journal.json
```

- `--inventory` is a path, an `http(s)` URL, or a release id resolved as
  `<releases>/<id>.inventory.json`. `--releases` is a local `simai/ui`
  checkout's `contracts/releases` folder or a URL of one, for example
  `https://raw.githubusercontent.com/simai/ui/main/contracts/releases`.
  Repeat `--inventory` for several sources (Framework, ui-pro, a package).
- The inventory of the record's own release is the foundations' baseline. It
  is resolved from `sources[].release` through `--releases`, or given with
  `--since`; the change reports between the two releases (`--changes`,
  repeatable) stand in for it. With none of them, the report says the
  foundations are unchecked.
- `--journal` is ui-source's change journal (`contracts/changes/journal.json`,
  path or URL). Without it a former id is reported missing and no instruction
  is quoted.
- `--out report.json` writes the report; `--json` prints it instead of the
  summary; `--today yyyy-mm-dd` fixes the day a former name is checked
  against.
- The exit code is 0 unless `--fail-on update-available|former-name|action-needed|missing`
  is given and a unit is at that status or worse (1). An unusable input exits 2.
- Reconcile never writes to the record or to anything of the consumer's.

### Statuses

Every unit of every place gets one status; a place takes its worst unit's.
From best to worst:

| Status | When |
| --- | --- |
| `current` | the inventory's content hash is the record's |
| `update-available` | a newer patch or minor; or the same version whose hash moved (a release-gate violation, reported as such) |
| `former-name` | the id is a former id of an inventory unit: the journal names the new id (`former.to`), the record and the date it stops working (`former.until`, `expired` once it passed) |
| `action-needed` | a major step (below 1.0.0, a minor one), or a journal entry between the two versions asks for a change -- its instruction is quoted |
| `missing` | the inventory has no such unit and no unit took its name, or the former name was removed |

**Foundations.** A unit's foundations are the token sets, fonts and icon sets
it names as dependencies in the target inventory, plus those of the units it
depends on, transitively (cycles included) -- but never through shared
infrastructure: units of kind `core` (`core.runtime`, `core.styles`) and
`module` are not followed, because every unit loads them and through them
every token set would mark every place. Each foundation is compared with the
baseline; one that moved adds a `via` entry -- `{id, kind, from_version,
to_version, step, status, chain}`, where `chain` is the shortest dependency
path from the unit to the foundation -- and the unit takes the worse of its
own status and the via's: `update-available` for a patch or minor,
`action-needed` for a major or a journal entry of the foundation. So a changed
`tokens.colour` marks every place drawn with a unit that reads it, even when
the unit's own hash is equal, and leaves a unit that reads only `tokens.space`
alone.

**Journal entries.** A record of the change journal applies to a unit when it
names it:

- with a version -- `units: [{id, version}]`, or `unit` and `version`, or an
  item's `unit` -- the entry counts when that version is above the record's
  and not above the target's (the per-version entries of requirement 7);
- without one -- the journal as it is today, matched by a Smart component's
  tag (`sf-button` for `smart.button`) -- the entry counts when it was recorded
  after the source's `brought_up_on`.

An entry whose `rewrite` is `none` asks for nothing and is left out. The
quoted instruction is the entry's `manual`, else its summary and its
before/after example. A former id is an item whose `from` and `to` are both
unit ids (`{"component": "registry", "from": "smart.inputs", "to": "smart.input"}`).

### The report

`simai.framework.unit-reconcile-report` v1: the consumer, the record's
sources, the target and baseline inventories' identities, the totals per
status (places and units), every place with its units, and notes on what was
not checked. A unit carries `status`, `current` (the inventory's id, version
and hash), and as they apply `step`, `reasons`, `former`, `journal`, `via`
and `foundations: "unchecked"`. Tools build on it: the Figma kit's drift
report, a documentation checklist, a project's upgrade list.

The summary on stdout reads:

```
Reconcile ui-kit (figma-kit) against simai/ui-source ui-bbbbbbbbbbbb since ui-aaaaaaaaaaaa
Places 3: 1 current, 1 former-name, 1 action-needed
Units 4: 1 current, 1 update-available, 1 former-name, 1 action-needed

[action-needed] figma:12:34 Button/primary
  smart.button 1.1.0 -> 2.0.0: action-needed
    major change 1.1.0 -> 2.0.0
    foundations moved: tokens.colour 1.0.0 -> 1.1.0
    via tokens.colour 1.0.0 -> 1.1.0 (minor): update-available
```

## Before publishing

A consumer that publishes (a documentation site, the Figma library, a product
release) runs reconcile first and says which places it leaves out of date and
why (requirement 16), for example with `--fail-on action-needed` in its
release route and the report kept beside the release.

## Tests

`yarn test:linkage` (`node --test tests/linkage/*.test.mjs`) runs the fixtures
in `tests/linkage/fixtures`: every status, a foundation reached through
another unit, a former name with its date, an expired and a removed one, a
quoted journal instruction, change reports in place of the baseline, the
record command, the exit codes, and loading over HTTP from a local server.
