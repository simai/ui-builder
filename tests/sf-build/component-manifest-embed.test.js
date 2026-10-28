"use strict";

// A Smart bundle embeds only the keys of its component.json the runtime reads
// (ui-source core/contracts/shared-runtime.v1.json component_manifest_keys),
// without the descriptive keys inside them the source lets it drop
// (component_manifest_drop).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    MANIFEST_FILE,
    applyComponentManifestEmbed,
    embeddedManifest,
    readEmbeddedDrop,
    readEmbeddedKeys,
} = require("../../libs/componentManifestEmbed");

function source(contract)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-embed-"));
    fs.mkdirSync(path.join(root, "core/contracts"), { recursive: true });
    if (contract) fs.writeFileSync(path.join(root, "core/contracts/shared-runtime.v1.json"), JSON.stringify(contract));
    return root;
}

const MANIFEST = {
    $comment: "a note",
    id: "smart.close",
    tag: "sf-close",
    version: "1.2.0",
    settings: { size: { type: "string", default: "1", "x-note": "kept: inside a kept key" } },
    events: { press: {} },
    relations: [{ name: "icons" }],
    aliases: { settings: [] },
    examples: [{ id: "page" }],
    "x-registry": { big: true },
    "x-decisions": ["version 1.2.0: ..."],
};

test("only the listed top-level keys are embedded, in the file's order, whole", () => {
    const embedded = embeddedManifest(MANIFEST, ["tag", "id", "settings", "events", "port"]);
    assert.deepEqual(Object.keys(embedded), ["id", "tag", "settings", "events"]);
    assert.deepEqual(embedded.settings, MANIFEST.settings);
    assert.equal(embeddedManifest(MANIFEST, null), MANIFEST, "no list: the whole file");
});

test("the list is the source's; a source without one embeds the whole file", () => {
    assert.equal(readEmbeddedKeys(source(null)), null);
    assert.equal(readEmbeddedKeys(source({ schema: "simai.framework.shared-runtime", abi: 1 })), null);
    assert.deepEqual(readEmbeddedKeys(source({ component_manifest_keys: ["tag", "settings"] })), ["tag", "settings"]);
    assert.throws(() => readEmbeddedKeys(source({ component_manifest_keys: [] })), /non-empty list/u);
    const configurations = [{}];
    assert.equal(applyComponentManifestEmbed(configurations, { sourceRoot: source(null) }), null);
    assert.equal(configurations[0].module, undefined);
});

test("the rule takes a Smart folder's component.json, of the Framework or of a package, and nothing else", () => {
    const configurations = [{ module: { rules: [{ test: /x/u }] } }];
    applyComponentManifestEmbed(configurations, { sourceRoot: source({ component_manifest_keys: ["tag"] }) });
    const rule = configurations[0].module.rules.at(-1);
    assert.equal(rule.type, "json");
    assert.deepEqual(rule.parser.parse(JSON.stringify(MANIFEST)), { tag: "sf-close" });
    for (const file of ["/w/src/smart/close/component.json", "/w/overlay/src/smart/data-view/component.json"]) assert.match(file, MANIFEST_FILE);
    for (const file of ["/w/src/smart/close/aliases.json", "/w/src/smart/close/lang/en.json", "/w/src/component/close/component.json", "/w/src/smart/close/js/component.json"]) assert.doesNotMatch(file, MANIFEST_FILE);
});

const DROP = ["$comment", "description", "examples", "summary", "x-outcomes", "x-returns", "x-summary"];

const DESCRIBED = {
    tag: "sf-pager",
    settings: {
        description: { type: "string", default: "", summary: "a setting named description" },
        summary: { type: "boolean", summary: "a setting named summary" },
        size: { type: "enum", values: ["1", "2"], default: "1", summary: "the size", examples: [["1"], ["2"]], "x-summary": "why" },
        items: { type: "list", of: { id: "string", label: { type: "string", summary: "a field's words" } } },
    },
    events: {
        $comment: "a member map's own comment: a name, kept",
        change: { carries: { current: { type: "number", summary: "the page" }, total: "number" }, "x-native": false, summary: "the page changed", $comment: "a note" },
    },
    actions: {
        "go-to": { with: { page: { type: "number", description: "where" } }, emits: "change", "x-outcomes": ["applied"], "x-returns": { type: "object", description: "the element" } },
    },
    form: { value: "checked", summary: "a key of a kept key's own object: kept" },
    examples: [{ id: "page" }],
};

// A member deeper than level 1 named like a dropped key (a carried field
// `summary`) would be dropped too: ui-source's contract test refuses such a
// component.json, so the build need not know which maps hold names.
test("inside a kept key, the dropped keys go from level 2 down; the names a key declares stay", () => {
    const embedded = embeddedManifest(DESCRIBED, ["tag", "settings", "events", "actions", "form"], DROP);
    assert.deepEqual(embedded, {
        tag: "sf-pager",
        settings: {
            description: { type: "string", default: "" },
            summary: { type: "boolean" },
            size: { type: "enum", values: ["1", "2"], default: "1" },
            items: { type: "list", of: { id: "string", label: { type: "string" } } },
        },
        events: {
            $comment: "a member map's own comment: a name, kept",
            change: { carries: { current: { type: "number" }, total: "number" }, "x-native": false },
        },
        actions: {
            "go-to": { with: { page: { type: "number" } }, emits: "change" },
        },
        form: { value: "checked", summary: "a key of a kept key's own object: kept" },
    });
    assert.equal(DESCRIBED.settings.size.summary, "the size", "the source's object is not changed");
    assert.deepEqual(embeddedManifest(DESCRIBED, ["tag", "settings"], null).settings, DESCRIBED.settings, "no drop list: the kept keys whole");
    assert.deepEqual(embeddedManifest(DESCRIBED, ["tag", "settings"], []).settings, DESCRIBED.settings, "an empty drop list: the kept keys whole");
    assert.equal(embeddedManifest(DESCRIBED, null, DROP), DESCRIBED, "no key list: the whole file");
});

test("the drop list is the source's; a source without one keeps the kept keys whole", () => {
    assert.equal(readEmbeddedDrop(source(null)), null);
    assert.equal(readEmbeddedDrop(source({ component_manifest_keys: ["tag"] })), null);
    assert.deepEqual(readEmbeddedDrop(source({ component_manifest_keys: ["tag"], component_manifest_drop: ["summary"] })), ["summary"]);
    assert.deepEqual(readEmbeddedDrop(source({ component_manifest_keys: ["tag"], component_manifest_drop: [] })), []);
    assert.throws(() => readEmbeddedDrop(source({ component_manifest_drop: "summary" })), /list of names/u);
    assert.throws(() => readEmbeddedDrop(source({ component_manifest_drop: ["summary", ""] })), /list of names/u);

    const keep = [{}];
    applyComponentManifestEmbed(keep, { sourceRoot: source({ component_manifest_keys: ["tag", "settings"] }) });
    assert.deepEqual(keep[0].module.rules.at(-1).parser.parse(JSON.stringify(DESCRIBED)).settings, DESCRIBED.settings);

    const drop = [{}];
    applyComponentManifestEmbed(drop, { sourceRoot: source({ component_manifest_keys: ["tag", "settings"], component_manifest_drop: DROP }) });
    const parsed = drop[0].module.rules.at(-1).parser.parse(JSON.stringify(DESCRIBED));
    assert.deepEqual(parsed.settings.size, { type: "enum", values: ["1", "2"], default: "1" });
    assert.ok("description" in parsed.settings && "summary" in parsed.settings, "settings named like a dropped key stay");
});
