"use strict";

// A Smart bundle embeds only the keys of its component.json the runtime reads
// (ui-source core/contracts/shared-runtime.v1.json component_manifest_keys).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    MANIFEST_FILE,
    applyComponentManifestEmbed,
    embeddedManifest,
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
