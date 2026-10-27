import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    STATUSES,
    checkRecord,
    closure,
    loadInventory,
    main,
    parseArguments,
    reconcile,
    recordFrom,
    summarize,
    versionStep,
} from "../../scripts/reconcile.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FIXTURES = path.join(HERE, "fixtures");
const CLI = path.join(ROOT, "scripts/reconcile.mjs");
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
const A = fixture("ui-aaaaaaaaaaaa.inventory.json");
const B = fixture("ui-bbbbbbbbbbbb.inventory.json");
const CHANGES = fixture("ui-bbbbbbbbbbbb.changes.json");
const JOURNAL = fixture("journal.json");
const USAGE = fixture("usage.json");
const TODAY = "2026-10-27";

const unitOf = (report, place, id) => report.places.find((entry) => entry.place === place).units.find((unit) => unit.id === id);
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const scratch = () => mkdtempSync(path.join(os.tmpdir(), "reconcile-"));

function capture()
{
    const out = [];
    const err = [];
    return { io: { stdout: { write: (value) => out.push(value) }, stderr: { write: (value) => err.push(value) } }, stdout: () => out.join(""), stderr: () => err.join("") };
}

test("the fixture record is a valid usage record and an unknown field is not", () => {
    assert.deepEqual(checkRecord(USAGE), []);
    const extra = structuredClone(USAGE);
    extra.places[0].units[0].colour = "red";
    delete extra.sources[0].release;
    assert.deepEqual(checkRecord(extra), [
        "sources[0].release: must be given (a release id, or null)",
        "places[0].units[0].colour: is not a field of the record",
    ]);
    assert.match(checkRecord({ schema: "x" }).join("\n"), /schema: must be simai\.framework\.unit-usage/u);
});

test("every status, with the record's release as the foundations' baseline", () => {
    const report = reconcile(USAGE, [B], { since: [A], journal: JOURNAL, today: TODAY });
    const status = (place, id) => unitOf(report, place, id).status;

    assert.equal(status("figma:1:1 Specimen", "font.inter"), "current");
    assert.equal(status("figma:1:2 Icon", "smart.icon"), "update-available");
    assert.equal(unitOf(report, "figma:1:2 Icon", "smart.icon").step, "patch");
    assert.equal(status("figma:1:3 Chip", "smart.chip"), "update-available");
    assert.match(unitOf(report, "figma:1:3 Chip", "smart.chip").reasons[0], /hash moved while the version did not/u);
    assert.equal(status("figma:1:4 Button", "smart.button"), "action-needed");
    assert.equal(unitOf(report, "figma:1:4 Button", "smart.button").step, "major");
    assert.equal(status("figma:1:7 Tree", "smart.tree"), "missing");
    assert.equal(report.status, "missing");
    assert.deepEqual(report.totals.units, { current: 2, "update-available": 3, "former-name": 1, "action-needed": 3, missing: 2 });
    assert.deepEqual(report.totals.places, { current: 1, "update-available": 3, "former-name": 1, "action-needed": 3, missing: 2 });
    assert.deepEqual(report.inventories, [{ source: "simai/ui-source", release: "ui-bbbbbbbbbbbb", revision: "b".repeat(40) }]);
    assert.equal(report.places.find((place) => place.place === "docs:/components/select.md").note, "the select page");
});

test("a journal entry between the versions makes a minor step action-needed and is quoted", () => {
    const report = reconcile(USAGE, [B], { since: [A], journal: JOURNAL, today: TODAY });
    const select = unitOf(report, "docs:/components/select.md", "smart.select");
    assert.equal(select.status, "action-needed");
    assert.equal(select.step, "minor");
    // select-old-entry (1.1.0) is below the record's 1.2.0 and is left out.
    assert.deepEqual(select.journal, [{
        id: "select-options-to-items",
        recorded_on: "2026-10-26",
        stage: "compat",
        version: "1.3.0",
        remove_after: "2026-12-01",
        instruction: "Write items= for options= on sf-select.",
    }]);
    assert.match(summarize(report), /journal select-options-to-items \(2026-10-26, 1\.3\.0\): "Write items= for options= on sf-select\."/u);
    // Without the journal the same unit is a plain minor update.
    assert.equal(unitOf(reconcile(USAGE, [B], { since: [A], today: TODAY }), "docs:/components/select.md", "smart.select").status, "update-available");
});

test("a former id gives the new id, its version and the date it stops working", () => {
    const report = reconcile(USAGE, [B], { since: [A], journal: JOURNAL, today: TODAY });
    const input = unitOf(report, "figma:1:6 Input (old id)", "smart.inputs");
    assert.equal(input.status, "former-name");
    assert.deepEqual(input.former, {
        to: "smart.input",
        version: "1.3.0",
        journal: "path-smart-inputs-to-input",
        until: "2026-12-01",
        instruction: "Write smart.input for smart.inputs in a manifest or a package contract.",
    });
    assert.equal(input.current.id, "smart.input");

    const expired = unitOf(reconcile(USAGE, [B], { since: [A], journal: JOURNAL, today: "2026-12-02" }), "figma:1:6 Input (old id)", "smart.inputs");
    assert.equal(expired.status, "former-name");
    assert.equal(expired.former.expired, true);

    // A former id whose record is removed is missing, and still names its successor.
    const toggle = unitOf(report, "figma:1:8 Toggle (removed id)", "smart.toggles");
    assert.equal(toggle.status, "missing");
    assert.equal(toggle.former.to, "smart.switch");
    assert.equal(toggle.former.until, "2026-10-01");

    // Without the journal a former id is just missing.
    assert.equal(unitOf(reconcile(USAGE, [B], { since: [A], today: TODAY }), "figma:1:6 Input (old id)", "smart.inputs").status, "missing");
});

test("a changed foundation marks a unit whose own hash is equal, transitively, with via", () => {
    const report = reconcile(USAGE, [B], { since: [A], journal: JOURNAL, today: TODAY });
    const card = unitOf(report, "figma:1:9 Card", "component.card");
    // component.card -> component.badge -> tokens.colour (minor): its own hash is equal.
    assert.equal(card.current.content_sha256, card.content_sha256);
    assert.equal(card.status, "update-available");
    assert.deepEqual(card.via, [{ id: "tokens.colour", kind: "tokens", from_version: "1.0.0", to_version: "1.1.0", step: "minor", status: "update-available", chain: ["component.card", "component.badge", "tokens.colour"] }]);

    const gap = unitOf(report, "project:src/pages/list.html", "utility.gap");
    assert.equal(gap.status, "action-needed");
    assert.deepEqual(gap.via.map((via) => [via.id, via.step, via.status]), [["tokens.space", "major", "action-needed"]]);
    assert.equal(report.places.find((place) => place.place === "project:src/pages/list.html").status, "action-needed");
    assert.match(summarize(report), /via tokens\.space 1\.0\.0 -> 2\.0\.0 \(major\): action-needed/u);
    assert.match(summarize(report), /via tokens\.colour 1\.0\.0 -> 1\.1\.0 \(minor\): update-available \[component\.card > component\.badge > tokens\.colour\]/u);
});

test("only tokens.colour moved: a unit that reads it is marked, one that reads only tokens.space is not", () => {
    // ui-cccccccccccc is ui-aaaaaaaaaaaa with tokens.colour 1.0.0 -> 1.1.0 and nothing else.
    const C = fixture("ui-cccccccccccc.inventory.json");
    const record = recordFrom(A, { units: ["component.alert"], place: "reads space", base: recordFrom(A, { units: ["component.badge"], place: "reads colour" }) });
    record.places.push({ place: "space via a utility", units: [USAGE.places.at(-1).units[0]] });
    const report = reconcile(record, [C], { since: [A], today: TODAY });

    const badge = unitOf(report, "reads colour", "component.badge");
    assert.equal(badge.status, "update-available");
    assert.deepEqual(badge.via.map((via) => [via.id, via.chain]), [["tokens.colour", ["component.badge", "tokens.colour"]]]);

    // component.alert reads tokens.space directly and reaches tokens.colour only
    // through core.runtime -> core.styles and module.shared: it is not marked.
    const alert = unitOf(report, "reads space", "component.alert");
    assert.equal(alert.status, "current");
    assert.equal(alert.via, undefined);
    assert.equal(unitOf(report, "space via a utility", "utility.gap").status, "current");
    assert.deepEqual(report.totals.places, { current: 2, "update-available": 1, "former-name": 0, "action-needed": 0, missing: 0 });
});

test("a foundation's own journal entry makes the via action-needed and is quoted", () => {
    const journal = structuredClone(JOURNAL);
    journal.records.push({ id: "colour-role-rename", recorded_on: "2026-10-26", stage: "compat", kind: "token", summary: "s", units: [{ id: "tokens.colour", version: "1.1.0" }], items: [], deprecated_on: "2026-10-26", remove_after: "2026-12-01", rewrite: "rename-token", manual: "Write --sf-colour-ink for --sf-colour-text." });
    const card = unitOf(reconcile(USAGE, [B], { since: [A], journal, today: TODAY }), "figma:1:9 Card", "component.card");
    assert.equal(card.status, "action-needed");
    assert.equal(card.via[0].journal[0].instruction, "Write --sf-colour-ink for --sf-colour-text.");
});

test("change reports stand in for the record's inventory; with neither, foundations are unchecked", () => {
    const byReports = reconcile(USAGE, [B], { changes: [CHANGES], journal: JOURNAL, today: TODAY });
    const card = unitOf(byReports, "figma:1:9 Card", "component.card");
    assert.equal(card.status, "update-available");
    assert.equal(card.via[0].id, "tokens.colour");

    const blind = reconcile(USAGE, [B], { journal: JOURNAL, today: TODAY });
    assert.equal(unitOf(blind, "figma:1:9 Card", "component.card").status, "current");
    assert.equal(unitOf(blind, "figma:1:9 Card", "component.card").foundations, "unchecked");
    assert.match(blind.notes.join("\n"), /foundations of simai\/ui-source are unchecked/u);
});

test("journal entries without a version are placed by the date the record was brought up", () => {
    const dated = structuredClone(USAGE);
    dated.sources[0].brought_up_on = "2026-10-20";
    const icon = unitOf(reconcile(dated, [B], { since: [A], journal: JOURNAL, today: TODAY }), "figma:1:2 Icon", "smart.icon");
    // icon-size-to-scale is newer than the date; icon-older is not; icon-note asks for nothing.
    assert.equal(icon.status, "action-needed");
    assert.deepEqual(icon.journal.map((entry) => entry.id), ["icon-size-to-scale"]);
    assert.equal(icon.journal[0].instruction, "sf-icon's size is its scale. (<sf-icon size=\"2\"> -> <sf-icon scale=\"2\">)");
});

test("a record against its own release is current throughout", () => {
    const report = reconcile({ ...USAGE, places: USAGE.places.filter((place) => !/old id|removed id/u.test(place.place)) }, [A], { journal: JOURNAL, today: TODAY });
    assert.equal(report.status, "current");
    assert.equal(report.notes.filter((note) => /unchecked/u.test(note)).length, 0);
});

test("versions, steps and the dependency closure with a cycle", () => {
    assert.equal(versionStep("1.2.3", "2.0.0"), "major");
    assert.equal(versionStep("1.2.3", "1.3.0"), "minor");
    assert.equal(versionStep("0.2.0", "0.3.0"), "major");
    assert.equal(versionStep("1.2.3", "1.2.4"), "patch");
    const byId = new Map(A.units.map((unit) => [unit.id, unit]));
    assert.deepEqual([...closure(byId, "component.card")], [
        ["component.badge", ["component.card", "component.badge"]],
        ["tokens.colour", ["component.card", "component.badge", "tokens.colour"]],
        ["tokens.elevation", ["component.card", "component.badge", "tokens.colour", "tokens.elevation"]],
    ]);
    assert.deepEqual([...closure(byId, "tokens.colour").keys()], ["tokens.elevation"]);
    // core.runtime, core.styles and module.shared are neither entered nor returned.
    assert.deepEqual([...closure(byId, "component.alert").keys()], ["tokens.space"]);
});

test("record starts a usage record and adds places to it", () => {
    const record = recordFrom(A, { units: ["smart.button", "font.inter"], place: "figma:9:9", consumer: "ui-kit", kind: "figma-kit", broughtUpOn: "2026-10-27" });
    assert.deepEqual(checkRecord(record), []);
    assert.deepEqual(record.sources, [{ source: "simai/ui-source", release: "ui-aaaaaaaaaaaa", revision: "a".repeat(40), brought_up_on: "2026-10-27" }]);
    assert.deepEqual(record.places[0].units[0], { id: "smart.button", version: "1.4.0", content_sha256: A.units.find((unit) => unit.id === "smart.button").content_sha256 });
    const more = recordFrom(A, { units: ["smart.icon"], place: "docs:/icon.md", note: "icon page", base: record });
    assert.deepEqual(more.places.map((place) => place.place), ["figma:9:9", "docs:/icon.md"]);
    assert.equal(record.places.length, 1, "the base is not changed");
    assert.throws(() => recordFrom(A, { units: ["smart.nope"], place: "x" }), /has no unit smart\.nope/u);
    assert.throws(() => recordFrom(B, { units: ["smart.icon"], place: "x", base: record }), /brought up to ui-aaaaaaaaaaaa/u);
});

test("the command line: summary, JSON report, --out, exit codes, and the record left as it was", () => {
    const directory = scratch();
    try
    {
        const usage = path.join(FIXTURES, "usage.json");
        const before = createHash("sha256").update(readFileSync(usage)).digest("hex");
        const out = path.join(directory, "report.json");
        const common = ["--record", usage, "--inventory", "ui-bbbbbbbbbbbb", "--releases", FIXTURES, "--journal", path.join(FIXTURES, "journal.json"), "--today", TODAY];

        const plain = run([...common, "--out", out]);
        assert.equal(plain.status, 0, plain.stderr);
        assert.match(plain.stdout, /since ui-aaaaaaaaaaaa/u);
        assert.match(plain.stdout, /\[former-name\] figma:1:6 Input \(old id\)/u);
        const report = JSON.parse(readFileSync(out, "utf8"));
        assert.equal(report.schema, "simai.framework.unit-reconcile-report");
        assert.deepEqual(report.since.map((entry) => entry.release), ["ui-aaaaaaaaaaaa"]);

        const json = run([...common, "--json"]);
        assert.deepEqual(JSON.parse(json.stdout), report);

        assert.equal(run([...common, "--fail-on", "action-needed"]).status, 1);
        assert.equal(run([...common, "--fail-on", "missing"]).status, 1);
        const onlyCurrent = path.join(directory, "current.json");
        writeFileSync(onlyCurrent, JSON.stringify({ ...USAGE, places: [USAGE.places[0]] }));
        assert.equal(run(["reconcile", "--record", onlyCurrent, "--inventory", path.join(FIXTURES, "ui-bbbbbbbbbbbb.inventory.json"), "--since", path.join(FIXTURES, "ui-aaaaaaaaaaaa.inventory.json"), "--fail-on", "update-available"]).status, 0);

        assert.equal(createHash("sha256").update(readFileSync(usage)).digest("hex"), before);

        const bad = path.join(directory, "bad.json");
        writeFileSync(bad, JSON.stringify({ schema: "simai.framework.unit-usage" }));
        const refused = run(["--record", bad, "--inventory", path.join(FIXTURES, "ui-bbbbbbbbbbbb.inventory.json")]);
        assert.equal(refused.status, 2);
        assert.match(refused.stderr, /not a valid usage record/u);
        assert.equal(run(["--record", usage, "--inventory", "ui-bbbbbbbbbbbb"]).status, 2, "a release id needs --releases");
        assert.equal(run([...common, "--fail-on", "current"]).status, 2);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("the record command writes a record that reconciles as current", async () => {
    const directory = scratch();
    try
    {
        const file = path.join(directory, "usage.json");
        const inventory = path.join(FIXTURES, "ui-aaaaaaaaaaaa.inventory.json");
        assert.equal(run(["record", "--from-inventory", inventory, "--units", "smart.button,component.card", "--place", "figma:1:1", "--consumer", "kit", "--kind", "figma-kit", "--out", file]).status, 0);
        assert.equal(run(["record", "--from-inventory", inventory, "--units", "font.inter", "--place", "docs:/fonts.md", "--add-to", file, "--out", file]).status, 0);
        const record = JSON.parse(readFileSync(file, "utf8"));
        assert.deepEqual(record.places.map((place) => place.units.map((unit) => unit.id)), [["smart.button", "component.card"], ["font.inter"]]);
        const capture1 = capture();
        assert.equal(await main(["--record", file, "--inventory", inventory, "--json"], capture1.io), 0);
        assert.equal(JSON.parse(capture1.stdout()).status, "current");
        const capture2 = capture();
        assert.equal(await main(["record", "--from-inventory", inventory, "--units", "smart.gone", "--place", "x"], capture2.io), 2);
        assert.match(capture2.stderr(), /has no unit smart\.gone/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("inventories, journals and change reports load from a URL", async (context) => {
    const files = new Map([
        ["/releases/ui-aaaaaaaaaaaa.inventory.json", "ui-aaaaaaaaaaaa.inventory.json"],
        ["/releases/ui-bbbbbbbbbbbb.inventory.json", "ui-bbbbbbbbbbbb.inventory.json"],
        ["/changes/journal.json", "journal.json"],
    ]);
    const server = http.createServer((request, response) => {
        const name = files.get(request.url);
        if (!name)
        {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(readFileSync(path.join(FIXTURES, name)));
    });
    try
    {
        await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    }
    catch (error)
    {
        context.skip(`no local listener: ${error.message}`);
        return;
    }
    try
    {
        const base = `http://127.0.0.1:${server.address().port}`;
        assert.equal((await loadInventory("ui-bbbbbbbbbbbb", `${base}/releases/`)).release, "ui-bbbbbbbbbbbb");
        assert.equal((await loadInventory(`${base}/releases/ui-aaaaaaaaaaaa.inventory.json`)).release, "ui-aaaaaaaaaaaa");
        await assert.rejects(loadInventory("ui-cccccccccccc", `${base}/releases`), /answered 404/u);

        const output = capture();
        const code = await main(["--record", path.join(FIXTURES, "usage.json"), "--inventory", "ui-bbbbbbbbbbbb", "--releases", `${base}/releases`, "--journal", `${base}/changes/journal.json`, "--today", TODAY, "--json"], output.io);
        assert.equal(code, 0, output.stderr());
        const report = JSON.parse(output.stdout());
        assert.equal(report.since[0].release, "ui-aaaaaaaaaaaa");
        assert.equal(unitOf(report, "figma:1:6 Input (old id)", "smart.inputs").status, "former-name");
    }
    finally
    {
        server.close();
    }
});

test("arguments parse in both --flag value and --flag=value forms", () => {
    assert.deepEqual(parseArguments(["--record=r.json", "--inventory", "a", "--inventory=b", "--json"]), {
        command: "reconcile",
        options: { inventory: ["a", "b"], since: [], changes: [], record: "r.json", json: true },
    });
    assert.equal(parseArguments(["record", "--units", "a,b"]).command, "record");
});

test("the schemas name the formats the script reads and writes", () => {
    const usage = JSON.parse(readFileSync(path.join(ROOT, "schemas/simai.framework.unit-usage.v1.schema.json"), "utf8"));
    const report = JSON.parse(readFileSync(path.join(ROOT, "schemas/simai.framework.unit-reconcile-report.v1.schema.json"), "utf8"));
    assert.equal(usage.properties.schema.const, "simai.framework.unit-usage");
    assert.deepEqual(usage.properties.consumer.properties.kind.enum, ["figma-kit", "docs", "product", "project", "example", "other"]);
    assert.equal(report.properties.schema.const, "simai.framework.unit-reconcile-report");
    assert.deepEqual(report.$defs.status.enum, [...STATUSES]);

    // Every top-level key and unit key the script writes is declared.
    const written = reconcile(USAGE, [B], { since: [A], journal: JOURNAL, today: TODAY });
    assert.deepEqual(Object.keys(written).sort(), [...report.required].sort());
    const unitKeys = new Set(Object.keys(report.properties.places.items.properties.units.items.properties));
    for (const place of written.places)
    {
        for (const unit of place.units)
        {
            for (const key of Object.keys(unit))
            {
                assert.ok(unitKeys.has(key), `${key} is not declared in the report schema`);
            }
        }
    }
});
