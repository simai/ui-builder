"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
    BARE_MODULES,
    CORE_MODULES,
    applySharedRuntimeExternals,
    runtimeIdFor,
} = require("../../libs/sharedRuntime");

// Smart and package bundles take lit and smart-base from the shared runtime
// Core loads once per page (2026-10-13), instead of a copy each.

const source = "/work/src";
const issuer = "/work/src/smart/close/index.js";

test("a product file's lit and Core imports become runtime externals", () => {
    assert.equal(runtimeIdFor({ context: "/work/src/smart/close", request: "lit", issuer }, source), "lit");
    assert.equal(runtimeIdFor({ context: "/work/src/smart/close", request: "../../core/js/smart-base", issuer }, source), "smart-base");
    assert.equal(runtimeIdFor({ context: "/work/src/smart/close", request: "../../core/js/position.js", issuer }, source), "position");
    assert.equal(runtimeIdFor({ context: "/work/src/smart/close", request: "./js/templates/default", issuer }, source), null);
});

test("a dependency's own imports stay inside its bundle", () => {
    assert.equal(runtimeIdFor({
        context: "/work/node_modules/lit",
        request: "lit-html",
        issuer: "/work/node_modules/lit/index.js",
    }, source), null);
    assert.equal(runtimeIdFor({
        context: "/work/node_modules/lit",
        request: "lit",
        issuer: "/work/node_modules/lit/x.js",
    }, source), null);
});

test("an external waits for the runtime by its id", () => {
    const [configuration] = applySharedRuntimeExternals([{}], { sourceRoot: source });
    assert.equal(configuration.externalsType, "promise");
    let value;
    configuration.externals[0]({ context: "/work/src/smart/close", request: "lit", contextInfo: { issuer } }, (error, result) => { value = result; });
    assert.match(value, /globalThis\.SF\.runtimeModule\("lit"\)/u);
    assert.match(value, /sf-runtime-ready/u, "waits for the runtime script when Core is not on the page");
});

test("the builder's ids are the runtime's keys, when ui-source sits beside it", (t) => {
    const runtime = path.resolve(__dirname, "../../../ui-source/src/core/js/runtime.js");
    if (!fs.existsSync(runtime))
    {
        t.skip("ui-source is not beside ui-builder");
        return;
    }
    const keys = [...fs.readFileSync(runtime, "utf8").matchAll(/^\s+"([^"]+)": asModule\(/gmu)].map((match) => match[1]);
    assert.deepEqual([...keys].sort(), [...BARE_MODULES, ...Object.keys(CORE_MODULES)].sort());
});
