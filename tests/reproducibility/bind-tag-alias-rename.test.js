"use strict";

// A Smart component renamed with a dated tag alias (sf-close -> sf-button-close,
// close -> button-close, smart.close -> smart.button-close) is one component:
// the new rule lists both tags, so the tag lists of the old and the new entry
// differ, and matching renames on identical tags alone dropped the component's
// curated readiness and curated_for to "discoverable".

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const TOOL = path.join(__dirname, "../../scripts/bind-generated-runtime-contracts.py");

function git(root, ...args)
{
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commit(root, files)
{
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "fixture@example.test");
    git(root, "config", "user.name", "Fixture");
    for (const [relativePath, content] of Object.entries(files))
    {
        const destination = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "fixture");
    return git(root, "rev-parse", "HEAD");
}

const CURATED_READINESS = { status: "ready", safe_to_suggest: true, profiles: ["plain-assets-v1"], blockers: [] };

function oldEntry()
{
    return {
        id: "smart.close", kind: "smart-component", name: "close", title: "Close", owner: "simai/ui",
        lifecycle: "experimental", readiness: CURATED_READINESS,
        provenance: { repository: "https://github.com/simai/ui", tag: null, commit: "0".repeat(40), source_refs: [] },
        documentation_refs: [], example_refs: ["simai/ui@x:examples/close.html"],
        runtime: { rule_name: "cl-close", tags: ["sf-close"], asset_paths: [], declared: { js: true, css: false } },
        requires: ["component.close"], curated_for: ["recipe.admin.collection"],
    };
}

function run({ newTags, aliases })
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-bind-tag-alias-"));
    const uiRoot = path.join(workspace, "ui");
    const sourceRoot = path.join(workspace, "ui-source");
    const release = commit(uiRoot, {
        "distr/smart/button-close/js/button-close.js": "runtime\n",
        "distr/smart/close/close.js": "forward\n",
        "distr/rule/rule.json": [
            { name: "cl-button-close", js: true, mode: "smart", relation: [{ name: "close" }], tags: newTags, type: "smart" },
            { name: "close", css: true, regex: "/sf-close/", type: "component" },
        ],
    });
    const sourceFiles = { "src/smart/button-close/smart.manifest.json": { title: "Button close", lifecycle: "experimental" } };
    if (aliases) sourceFiles["src/smart/button-close/aliases.json"] = { component: "sf-button-close", aliases };
    const sourceRevision = commit(sourceRoot, sourceFiles);
    const manifest = { defaults: { readiness: { profiles: ["plain-assets-v1"] } }, inventory: { expected: 1 }, entries: [oldEntry()] };
    const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('bind',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
from pathlib import Path
ui=Path(sys.argv[2]);args=json.loads(sys.argv[5])
relation=lambda name,kinds:('smart.' if kinds.get(name)=='smart' else 'component.')+name
manifest,added,removed=mod.sync_smart_entries(args,ui,sys.argv[3],sys.argv[3],Path(sys.argv[4]),sys.argv[6],{},relation)
print(json.dumps({'manifest':manifest,'added':added,'removed':removed}))
`;
    const output = execFileSync("python3", ["-c", script, TOOL, uiRoot, release, sourceRoot, JSON.stringify(manifest), sourceRevision], { encoding: "utf8" });
    fs.rmSync(workspace, { recursive: true, force: true });
    return JSON.parse(output.trim().split("\n").pop());
}

const TAG_ROW = { from: "sf-close", to: "sf-button-close", kind: "tag", component: "sf-button-close", since: "2026-11-03", remove_after: "2027-01-01" };

test("a tag-alias rename keeps every curated decision under the new id", () =>
{
    const { manifest, added, removed } = run({ newTags: ["sf-button-close", "sf-close"], aliases: [TAG_ROW] });
    assert.deepEqual(added, []);
    assert.deepEqual(removed, []);
    assert.equal(manifest.entries.length, 1);
    const entry = manifest.entries[0];
    assert.equal(entry.id, "smart.button-close");
    assert.equal(entry.name, "button-close");
    assert.deepEqual(entry.readiness, CURATED_READINESS);
    assert.deepEqual(entry.curated_for, ["recipe.admin.collection"]);
    assert.deepEqual(entry.example_refs, ["simai/ui@x:examples/close.html"]);
    assert.equal(entry.title, "Close");
    assert.equal(entry.lifecycle, "experimental");
    assert.equal(entry.renamed_from, undefined);
    // Facts of the bytes and the rule come from the release, not the old entry.
    assert.deepEqual(entry.runtime.tags, ["sf-button-close", "sf-close"]);
    assert.equal(entry.runtime.rule_name, "cl-button-close");
    assert.deepEqual(entry.requires, ["component.close"]);
    assert.equal(manifest.inventory.expected, 1);
});

test("old tags on the new rule without a declared tag alias are not a rename", () =>
{
    const { manifest, added, removed } = run({ newTags: ["sf-button-close", "sf-close"], aliases: null });
    assert.deepEqual(added, ["smart.button-close"]);
    assert.deepEqual(removed, ["smart.close"]);
    assert.equal(manifest.entries[0].readiness.status, "discoverable");
    assert.deepEqual(manifest.entries[0].curated_for, []);
});

test("a declared alias whose old tag the rule no longer lists is not a rename", () =>
{
    const { added, removed } = run({ newTags: ["sf-button-close"], aliases: [TAG_ROW] });
    assert.deepEqual(added, ["smart.button-close"]);
    assert.deepEqual(removed, ["smart.close"]);
});

test("a folder rename with the same tags still keeps the curated decisions", () =>
{
    const { manifest, added, removed } = run({ newTags: ["sf-close"], aliases: null });
    assert.deepEqual(added, []);
    assert.deepEqual(removed, []);
    assert.equal(manifest.entries[0].id, "smart.button-close");
    assert.deepEqual(manifest.entries[0].curated_for, ["recipe.admin.collection"]);
});
