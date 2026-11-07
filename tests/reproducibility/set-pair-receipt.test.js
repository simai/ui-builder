"use strict";

// Pair receipts (owner decision 2026-11-07): a released component set,
// unchanged, re-receipted over another SIMAI Framework pair. pair-receipt.py
// check and publish, its equivalence rule, and set-index.py pair. `run` drives
// a real set's gates and a real build; it is exercised on a set checkout
// (decision record ui-control control/decisions/2026-11-07-set-pair-receipts.md).

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPTS = path.resolve(__dirname, "../../scripts");
const PAIR_RECEIPT = path.join(SCRIPTS, "pair-receipt.py");
const INDEX = path.join(SCRIPTS, "set-index.py");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hex = (character, length) => character.repeat(length);
const SOURCE = hex("a", 40);
const ID = `fx-${SOURCE.slice(0, 12)}`;

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });

function git(root, ...args)
{
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

const lock = () => ({
    schema: "simai.framework.package-release-lock",
    schema_version: 1,
    id: ID,
    package: "fx",
    version: "1.0.0",
    source: { repository: "example/ui-fx", path: "package", revision: SOURCE, tree: hex("1", 40) },
    build: { revision: hex("b", 40), path: "package/dist", tree: hex("2", 40), archive_sha256: hex("3", 64) },
    receipt: { path: "package/dist/package-receipt.json", sha256: hex("4", 64) },
    output: { manifest_sha256: hex("5", 64), archive_sha256: hex("6", 64), files_count: 5 },
    requires: { framework: "ui-111111111111", source: hex("c", 40), core_runtime: ">=1.25.0" },
    requires_sets: [],
    builder: { repository: "simai/ui-builder", revision: hex("d", 40), clean: true },
    claims: { production_ready: false },
});

const receipt = (extra = {}) => ({
    schema: "simai.framework.set-pair-receipt",
    schema_version: 1,
    set: "fx",
    release: ID,
    version: "1.0.0",
    repository: "example/ui-fx",
    package: {
        source_revision: SOURCE, build_revision: hex("b", 40), receipt_sha256: hex("4", 64),
        manifest_sha256: hex("5", 64), archive_sha256: hex("6", 64), files_count: 5,
    },
    built_over: { pair: "ui-111111111111", source_revision: hex("c", 40) },
    pair: { id: "ui-222222222222", commit: `222222222222${hex("e", 28)}`, source_revision: hex("f", 40), core_runtime: "1.31.0", npm: null },
    checks: { equivalence: { status: "same-bytes", differs: ["set.json"], passport_differs_in: ["framework.source_revision"] } },
    gates: {},
    tooling: {},
    status: "passed",
    created_on: "2026-11-07",
    claims: { production_ready: false },
    ...extra,
});

function files(directory, values)
{
    for (const [name, value] of Object.entries(values))
    {
        fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
        fs.writeFileSync(path.join(directory, name), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    }
}

test("check takes a pair receipt of this very release over another pair, and nothing else", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "pair-receipt-"));
    files(work, { "lock.json": lock(), "good.json": receipt() });
    const good = run("python3", [PAIR_RECEIPT, "check", "--receipt", path.join(work, "good.json"), "--lock", path.join(work, "lock.json")]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).status, "agrees");

    const refused = (name, value, pattern) => {
        files(work, { [name]: value });
        const result = run("python3", [PAIR_RECEIPT, "check", "--receipt", path.join(work, name), "--lock", path.join(work, "lock.json")]);
        assert.notEqual(result.status, 0, name);
        assert.match(result.stderr, pattern, name);
    };
    refused("bytes.json", receipt({ package: { ...receipt().package, archive_sha256: hex("7", 64) } }), /package.archive_sha256/u);
    refused("own-pair.json", receipt({ pair: { ...receipt().pair, id: "ui-111111111111", commit: `111111111111${hex("e", 28)}` } }), /another free pair/u);
    refused("red.json", receipt({ status: "failed" }), /did not pass/u);
    refused("differs.json", receipt({ checks: { equivalence: { status: "differs" } } }), /did not pass/u);
    refused("other-release.json", receipt({ version: "1.0.1" }), /version 1.0.1, the lock says 1.0.0/u);
    refused("extra.json", { ...receipt(), note: "x" }, /not a simai.framework.set-pair-receipt/u);
});

test("equivalence allows the repinned passport field alone", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "pair-equivalence-"));
    const passport = { id: "fx", framework: { core_runtime: ">=1.25.0", source_revision: hex("c", 40) } };
    files(path.join(work, "released"), { "set.json": passport, "smart/rule.js": "rule\n", "smart/glow/js/glow.js": "glow\n" });
    files(path.join(work, "same"), { "set.json": { ...passport, framework: { ...passport.framework, source_revision: hex("f", 40) } },
        "smart/rule.js": "rule\n", "smart/glow/js/glow.js": "glow\n" });
    files(path.join(work, "bundle"), { "set.json": passport, "smart/rule.js": "rule\n", "smart/glow/js/glow.js": "glow 2\n" });
    files(path.join(work, "minimum"), { "set.json": { ...passport, framework: { ...passport.framework, core_runtime: ">=1.31.0" } },
        "smart/rule.js": "rule\n", "smart/glow/js/glow.js": "glow\n" });
    const compare = (name) => {
        const result = run("python3", ["-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('pair', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
released = module.receipts.files_under(sys.argv[2])
print(json.dumps(module.equivalence(sys.argv[3], sys.argv[2], released)))`, PAIR_RECEIPT, path.join(work, "released"), path.join(work, name)]);
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };
    assert.deepEqual([compare("same").status, compare("same").passport_differs_in], ["same-bytes", ["framework.source_revision"]]);
    assert.deepEqual([compare("bundle").status, compare("bundle").differs], ["differs", ["smart/glow/js/glow.js"]]);
    assert.deepEqual([compare("minimum").status, compare("minimum").passport_differs_in], ["differs", ["framework.core_runtime"]]);
});

test("the index lists a pair once on its release row, never the row's own pair, and the row keeps its facts", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "pair-index-"));
    const row = {
        set: "fx", release: ID, version: "1.0.0", source_revision: SOURCE,
        framework: { core_runtime: ">=1.25.0", source_revision: hex("c", 40), pair: "ui-111111111111" },
        requires_sets: [], receipt_sha256: hex("4", 64), archive_sha256: hex("6", 64), published_on: "2026-11-06",
    };
    const index = {
        schema: "simai.framework.set-index", schema_version: 1, summary: "s",
        sets: [{ id: "fx", title: "Fx", repository: "example/ui-fx", npm: "@simai-studio/fx", licence: { class: "framework", spdx: "Apache-2.0" }, docs: "https://fx.example.org/" }],
        releases: [row],
    };
    const indexPath = path.join(work, "index.json");
    files(work, { "index.json": index, "receipt.json": receipt(), "foreign.json": receipt({ version: "2.0.0" }) });
    const pair = (name) => run("python3", [INDEX, "pair", "--index", indexPath, "--receipt", path.join(work, name), "--received-on", "2026-11-07"]);

    const added = pair("receipt.json");
    assert.equal(added.status, 0, added.stderr);
    const value = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.deepEqual(value.releases[0].pairs, [{
        pair: "ui-222222222222", source_revision: hex("f", 40),
        receipt_sha256: sha256(fs.readFileSync(path.join(work, "receipt.json"))), received_on: "2026-11-07",
    }]);
    const { pairs, ...facts } = value.releases[0];
    assert.deepEqual(facts, row, "the row's facts did not change");
    assert.match(pair("receipt.json").stderr, /already runs over ui-222222222222/u);
    assert.match(pair("foreign.json").stderr, /not of the indexed/u);
    assert.equal(run("python3", [INDEX, "check", "--index", indexPath]).status, 0);

    value.releases[0].pairs.push({ ...pairs[0], pair: "ui-111111111111" });
    fs.writeFileSync(indexPath, JSON.stringify(value));
    assert.match(run("python3", [INDEX, "check", "--index", indexPath]).stderr, /pairs\[1\]\.pair/u);
    value.releases[0].pairs = [];
    fs.writeFileSync(indexPath, JSON.stringify(value));
    assert.match(run("python3", [INDEX, "check", "--index", indexPath]).stderr, /non-empty list/u);
});

test("publish lays the receipt once beside the release lock, without uploading when told", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pair-publish-"));
    git(repo, "init", "-q", "-b", "main");
    files(repo, { [`contracts/releases/${ID}.lock.json`]: lock() });
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "bind");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "pair-publish-work-"));
    files(work, { "pair-receipt-ui-222222222222.json": receipt() });
    const publish = () => run("python3", [PAIR_RECEIPT, "publish", "--repo", repo, "--receipt", path.join(work, "pair-receipt-ui-222222222222.json"), "--no-upload"]);
    const laid = publish();
    assert.equal(laid.status, 0, laid.stderr);
    const target = path.join(repo, `contracts/pair-receipts/${ID}/ui-222222222222.json`);
    assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(path.join(work, "pair-receipt-ui-222222222222.json"), "utf8"));
    assert.match(publish().stderr, /is written once/u);

    // A release lock with local edits is not immutable: refused.
    fs.writeFileSync(path.join(repo, `contracts/releases/${ID}.lock.json`), "{}\n");
    fs.rmSync(target);
    assert.match(publish().stderr, /a release lock is immutable/u);
});
