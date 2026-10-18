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
    assert.match(value, /\.runtimeModule\("lit"\)/u);
    // The lookup is asked of SF.__internal first, then of SF (an older Core).
    assert.match(value, /s\.__internal && s\.__internal\.runtimeModule \? s\.__internal : s/u);
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

// A name imported from a runtime module is read off the namespace Core hands
// over, in the browser; one the module does not export was undefined at run
// time and no build said so. The build now fails on it.
test("an import of a name a runtime module does not export fails the build", async () => {
    const os = require("node:os");
    const webpack = require("webpack");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sf-runtime-exports-")));
    try
    {
        fs.mkdirSync(path.join(root, "core", "js"), { recursive: true });
        fs.mkdirSync(path.join(root, "smart", "x"), { recursive: true });
        fs.writeFileSync(path.join(root, "core", "js", "page-language.js"), "export function pageText() { return ''; }\n");
        const entry = path.join(root, "smart", "x", "index.js");
        const compile = (source) => new Promise((resolve, reject) => {
            fs.writeFileSync(entry, source);
            const [configuration] = applySharedRuntimeExternals([{
                mode: "none",
                context: root,
                entry,
                output: { path: path.join(root, "out"), filename: "x.js" },
            }], { sourceRoot: root });
            webpack(configuration, (error, stats) => (error ? reject(error) : resolve(stats.toJson({ all: false, errors: true }).errors.map((item) => item.message))));
        });
        assert.deepEqual(await compile("import {pageText} from '../../core/js/page-language';\nconsole.log(pageText);\n"), []);
        const errors = await compile("import {pageText, pageWords} from '../../core/js/page-language';\nconsole.log(pageText, pageWords);\n");
        assert.equal(errors.length, 1);
        assert.match(errors[0], /imports "pageWords" from the runtime module "page-language", which does not export it/);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// A workspace under a symlinked directory (macOS's /var/folders is
// /private/var/folders) resolves the same: the importer's real path and the
// source root's linked one name one file (docs trial 4, 2026-10-15).
test("a source root reached through a symlink still finds the runtime modules", () => {
    const os = require("node:os");
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sf-runtime-real-"));
    const linked = `${real}-link`;
    try
    {
        fs.mkdirSync(path.join(real, "src", "smart", "close"), { recursive: true });
        fs.symlinkSync(real, linked);
        const linkedSource = path.join(linked, "src");
        const realContext = path.join(fs.realpathSync(real), "src", "smart", "close");
        assert.equal(runtimeIdFor({
            context: realContext,
            request: "../../core/js/smart-base",
            issuer: path.join(realContext, "index.js"),
        }, linkedSource), "smart-base");
    }
    finally
    {
        fs.rmSync(linked, { force: true });
        fs.rmSync(real, { force: true, recursive: true });
    }
});
