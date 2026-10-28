"use strict";

// The shared runtime's contract (ui-source core/contracts/shared-runtime.v1.json,
// 2026-10-28): a bundle asks with the source's runtime ABI, only for the ids
// that source's runtime hands out; a build reports the modules and names it
// asks for.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    applySharedRuntimeExternals,
    runtimeIdFor,
    runtimeUsageReport,
} = require("../../libs/sharedRuntime");

function source({ ids, contract })
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-runtime-"));
    fs.mkdirSync(path.join(root, "core/js"), { recursive: true });
    fs.mkdirSync(path.join(root, "core/contracts"), { recursive: true });
    fs.writeFileSync(path.join(root, "core/js/runtime.js"), `export const RUNTIME_MODULES = Object.freeze({\n${ids.map((id) => `  "${id}": asModule(x),`).join("\n")}\n});\n`);
    if (contract) fs.writeFileSync(path.join(root, "core/contracts/shared-runtime.v1.json"), JSON.stringify(contract));
    return fs.realpathSync(root);
}

const CONTRACT = {
    schema: "simai.framework.shared-runtime",
    version: 1,
    abi: 1,
    script: "core/js/smart-base.js",
    core_hosted: ["aliases", "position"],
    modules: {
        aliases: { source: "core/js/aliases.js", exports: ["installAliases"] },
        position: { source: "core/js/position.js", exports: ["default"] },
        "element-manifest": { source: "core/js/element-manifest.js", exports: ["elementFromManifest"] },
        lit: { source: "lit", exports: null },
    },
};

test("an id the source's own runtime does not hand out stays in the bundle", () => {
    // A package built over a release from before the element layer was shared.
    const root = source({ ids: ["lit", "smart-base"] });
    const issuer = path.join(root, "smart/close/index.js");
    const context = path.join(root, "smart/close");
    assert.equal(runtimeIdFor({ context, request: "../../core/js/smart-base", issuer }, root), "smart-base");
    assert.equal(runtimeIdFor({ context, request: "../../core/js/element-manifest", issuer }, root), null);
    const later = source({ ids: ["lit", "smart-base", "element-manifest"] });
    assert.equal(runtimeIdFor({ context: path.join(later, "smart/close"), request: "../../core/js/element-manifest", issuer: path.join(later, "smart/close/index.js") }, later), "element-manifest");
});

test("a bundle asks with the ABI of the source it was built from", () => {
    const root = source({ ids: ["lit", "element-manifest"], contract: CONTRACT });
    const [configuration] = applySharedRuntimeExternals([{}], { sourceRoot: root });
    let value;
    configuration.externals[0]({ context: path.join(root, "smart/close"), request: "../../core/js/element-manifest", contextInfo: { issuer: path.join(root, "smart/close/index.js") } }, (error, result) => { value = result; });
    assert.match(value, /globalThis\.SF\.runtimeModule\("element-manifest", 1\)/u);
    assert.match(value, /\.then\(resolve, reject\)/u, "a refusal reaches the bundle when the runtime arrives later");
    const old = source({ ids: ["lit"] });
    const [plain] = applySharedRuntimeExternals([{}], { sourceRoot: old });
    plain.externals[0]({ context: path.join(old, "smart/close"), request: "lit", contextInfo: { issuer: path.join(old, "smart/close/index.js") } }, (error, result) => { value = result; });
    assert.match(value, /runtimeModule\("lit"\)/u, "a source without the contract: no ABI");
});

test("a build reports the runtime modules and names its bundles ask for", () => {
    const root = source({ ids: ["lit"], contract: CONTRACT });
    const report = runtimeUsageReport({ lit: new Set(["html", "nothing"]), "element-manifest": new Set(["elementFromManifest"]) }, root);
    assert.deepEqual(report, {
        schema: "simai.framework.shared-runtime-usage",
        version: 1,
        abi: 1,
        modules: { "element-manifest": ["elementFromManifest"], lit: ["html", "nothing"] },
    });
});
