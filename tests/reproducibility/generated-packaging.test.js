"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const {
    assertShippedPortKits,
    materializeGeneratedPackaging,
    portKitDigest,
} = require("../../libs/generatedPackaging");

function writeFile(root, relativePath, content)
{
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
    return destination;
}

function fixture()
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-generated-packaging-"));
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");
    const input = writeFile(sourceRoot, "utility/space/default/index.scss", ".space {}\n");
    writeFile(sourceRoot, "utility/space/default/index.js", "");
    writeFile(sourceRoot, "utility/space/default/data.json", "{\"ok\":true}\n");
    writeFile(sourceRoot, "utility/space/default/fallback.otf", "font-data\n");
    writeFile(sourceRoot, "utility/space/default/private.ttf", "not distributed\n");
    writeFile(sourceRoot, "utility/space/default/private.md", "not distributed\n");
    writeFile(outputRoot, "utility/space/default/css/default.css", ".space {}\n");

    return {
        outputRoot,
        plan: {
            entries: [{
                input,
                key: "utility/space/default",
                outputDirectory: path.join(outputRoot, "utility/space/default"),
                target: "utility",
            }],
            outputRoot,
            sourceRoot,
        },
        sourceRoot,
        workspace,
    };
}

test("generated packaging materializes source assets, empty URL compatibility and gzip", () => {
    const subject = fixture();

    try
    {
        const result = materializeGeneratedPackaging(subject.plan);
        const css = path.join(subject.outputRoot, "utility/space/default/css/default.css");
        const json = path.join(subject.outputRoot, "utility/space/default/data.json");
        const font = path.join(subject.outputRoot, "utility/space/default/fallback.otf");
        const compatibility = path.join(subject.outputRoot, "utility/space/default/js/default.js");
        const aggregateCompatibility = path.join(
            subject.outputRoot,
            "utility/js/utility.js",
        );

        assert.equal(fs.readFileSync(json, "utf8"), "{\"ok\":true}\n");
        assert.equal(fs.readFileSync(font, "utf8"), "font-data\n");
        assert.equal(fs.statSync(compatibility).size, 0);
        assert.equal(fs.statSync(aggregateCompatibility).size, 0);
        assert.equal(fs.existsSync(path.join(subject.outputRoot, "utility/space/default/private.md")), false);
        assert.equal(fs.existsSync(path.join(subject.outputRoot, "utility/space/default/private.ttf")), false);
        assert.deepEqual(zlib.gunzipSync(fs.readFileSync(`${css}.gz`)), fs.readFileSync(css));
        assert.deepEqual(zlib.gunzipSync(fs.readFileSync(`${json}.gz`)), fs.readFileSync(json));
        assert.deepEqual(zlib.gunzipSync(fs.readFileSync(`${compatibility}.gz`)), Buffer.alloc(0));
        assert.equal(result.sourceAssets.length, 2);
        assert.equal(result.compatibilityScripts.length, 2);
        assert.equal(result.gzip.length, 4);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("Core packaging publishes only the Composition and Assembly ESM runtimes", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-composition-packaging-"));
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");
    const input = writeFile(sourceRoot, "core/js/index.js", "export {};\n");
    writeFile(sourceRoot, "core/js/composition/index.mjs", "export const Composition = {};\n");
    writeFile(sourceRoot, "core/js/assembly/index.mjs", "export const Assembly = {};\n");
    writeFile(sourceRoot, "core/js/other/private.mjs", "export {};\n");
    writeFile(sourceRoot, "core/contracts/checks/private.mjs", "throw new Error('not public');\n");
    fs.mkdirSync(outputRoot, { recursive: true });
    writeFile(outputRoot, ".compat/utility-full/css/utility.full.css", "");

    try
    {
        const result = materializeGeneratedPackaging({
            entries: [{ input, key: "core", outputDirectory: path.join(outputRoot, "core"), target: "core" }],
            outputRoot,
            sourceRoot,
        });
        const runtime = path.join(outputRoot, "core/js/composition/index.mjs");

        assert.equal(fs.readFileSync(runtime, "utf8"), "export const Composition = {};\n");
        assert.deepEqual(zlib.gunzipSync(fs.readFileSync(`${runtime}.gz`)), fs.readFileSync(runtime));
        const assembly = path.join(outputRoot, "core/js/assembly/index.mjs");

        assert.equal(fs.readFileSync(assembly, "utf8"), "export const Assembly = {};\n");
        assert.equal(fs.existsSync(path.join(outputRoot, "core/contracts/checks/private.mjs")), false);
        assert.equal(fs.existsSync(path.join(outputRoot, "core/js/other/private.mjs")), false);
        assert.deepEqual([...result.sourceAssets].sort(), [assembly, runtime].sort());
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});

test("Core packages capability bundle Markdown only from its own verified lock", () => {
    const subject = fixture();
    const prefix = "core/contracts/composition-regions-v1/";
    const content = "# Composition Regions 1.0.0\n";
    const input = writeFile(subject.sourceRoot, "core/index.js", "export {};\n");
    const readme = writeFile(subject.sourceRoot, `${prefix}README.md`, content);
    writeFile(subject.sourceRoot, `${prefix}checks/digest-parity.php`, "<?php\n");
    writeFile(subject.sourceRoot, `${prefix}notes.md`, "not public\n");
    writeFile(subject.sourceRoot, "core/contracts/unrelated-v1/README.md", "not public\n");
    const lock = writeFile(subject.sourceRoot, `${prefix}contract.lock.json`, JSON.stringify({
        schema: "simai.composition.capability-contract-lock.v1",
        version: "1.0.0",
        normativeFiles: {
            "README.md": `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`,
        },
    }));
    subject.plan.entries = [{ input, key: "core", target: "core",
        outputDirectory: path.join(subject.outputRoot, "core") }];
    writeFile(subject.outputRoot, ".compat/utility-full/css/utility.full.css", "");

    try
    {
        materializeGeneratedPackaging(subject.plan);
        assert.equal(fs.readFileSync(path.join(subject.outputRoot, `${prefix}README.md`), "utf8"), content);
        assert.equal(fs.existsSync(path.join(subject.outputRoot, `${prefix}contract.lock.json`)), true);
        assert.equal(fs.existsSync(path.join(subject.outputRoot, `${prefix}notes.md`)), false);
        assert.equal(fs.existsSync(path.join(subject.outputRoot, `${prefix}checks/digest-parity.php`)), false);
        assert.equal(fs.existsSync(path.join(subject.outputRoot, "core/contracts/unrelated-v1/README.md")), false);
        fs.writeFileSync(readme, "changed bytes");
        assert.throws(() => materializeGeneratedPackaging(subject.plan), /composition-regions-v1 normative digest mismatch/);
        fs.writeFileSync(readme, content);
        fs.writeFileSync(lock, JSON.stringify({ schema: "simai.composition.recipe-contract-lock.v1", normativeFiles: {} }));
        assert.throws(() => materializeGeneratedPackaging(subject.plan), /invalid Composition capability composition-regions-v1 normative-file lock/);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("Core packages lock-listed normative Markdown and rejects incomplete or changed bytes", () => {
    const subject = fixture();
    const prefix = "core/contracts/composition-recipe-v1/";
    const content = "# Accepted Recipe 1.0.1\n";
    const input = writeFile(subject.sourceRoot, "core/index.js", "export {};\n");
    const readme = writeFile(subject.sourceRoot, `${prefix}README.md`, content);
    writeFile(subject.sourceRoot, `${prefix}internal.md`, "not public\n");
    writeFile(subject.sourceRoot, `${prefix}contract.lock.json`, JSON.stringify({
        schema: "simai.composition.recipe-contract-lock.v1",
        version: "1.0.1",
        normativeFiles: {
            "README.md": `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`,
        },
    }));
    subject.plan.entries = [{ input, key: "core", target: "core",
        outputDirectory: path.join(subject.outputRoot, "core") }];
    writeFile(subject.outputRoot, ".compat/utility-full/css/utility.full.css", "");

    try
    {
        materializeGeneratedPackaging(subject.plan);
        assert.equal(fs.readFileSync(path.join(subject.outputRoot, `${prefix}README.md`), "utf8"), content);
        assert.equal(fs.existsSync(path.join(subject.outputRoot, `${prefix}internal.md`)), false);
        fs.writeFileSync(readme, "changed bytes");
        assert.throws(() => materializeGeneratedPackaging(subject.plan), /normative digest mismatch/);
        fs.unlinkSync(readme);
        assert.throws(() => materializeGeneratedPackaging(subject.plan), /missing or unsafe Recipe normative file/);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("gzip is byte-identical across independent roots", () => {
    const first = fixture();
    const second = fixture();

    try
    {
        materializeGeneratedPackaging(first.plan);
        materializeGeneratedPackaging(second.plan);
        const relative = "utility/space/default/css/default.css.gz";
        assert.deepEqual(
            fs.readFileSync(path.join(first.outputRoot, relative)),
            fs.readFileSync(path.join(second.outputRoot, relative)),
        );
    }
    finally
    {
        fs.rmSync(first.workspace, { force: true, recursive: true });
        fs.rmSync(second.workspace, { force: true, recursive: true });
    }
});

// The bytes of a .gz do not depend on the machine that wrote it: the header
// names no operating system and no time, and the deflate stream is pako's,
// the same on arm64 macOS and x64 Linux. The digest is pinned, so CI on both
// platforms (ci.yml) holds it -- a Mac-built receipt reproduces on Linux.
test("gzip bytes are the same on every platform", () => {
    const { deterministicGzip } = require("../../libs/generatedPackaging");
    const input = Buffer.from(".sf-probe{color:red}\n".repeat(50));
    const output = deterministicGzip(input);
    assert.equal(output.subarray(0, 10).toString("hex"), "1f8b08000000000002ff");
    assert.deepEqual(zlib.gunzipSync(output), input);
    assert.equal(
        crypto.createHash("sha256").update(output).digest("hex"),
        "754d046396f27f8edb158ba2ea5396284ca422677c3516dc0fb5043c0605de93",
    );
});

test("generated JavaScript has deterministic trailing whitespace removed before gzip", () => {
    const subject = fixture();
    const javascript = writeFile(
        subject.outputRoot,
        "smart/modal/js/modal.js",
        "const value = true; \t\n/******/ \t\n",
    );

    try
    {
        const result = materializeGeneratedPackaging(subject.plan);
        const canonical = "const value = true;\n/******/\n";

        assert.equal(fs.readFileSync(javascript, "utf8"), canonical);
        assert.deepEqual(
            zlib.gunzipSync(fs.readFileSync(`${javascript}.gz`)),
            Buffer.from(canonical),
        );
        assert.deepEqual(result.normalizedText, [fs.realpathSync(javascript)]);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("stylesheet-only compatibility JS materializes an empty URL artifact", () => {
    const subject = fixture();
    writeFile(
        subject.sourceRoot,
        "utility/space/default/index.js",
        "import './scss/index.scss';\n",
    );

    try
    {
        const result = materializeGeneratedPackaging(subject.plan);
        const compatibility = path.join(
            subject.outputRoot,
            "utility/space/default/js/default.js",
        );

        assert.equal(fs.statSync(compatibility).size, 0);
        assert.equal(result.compatibilityScripts.length, 2);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("SCSS entries without an adjacent JS source keep an empty URL artifact", () => {
    const subject = fixture();
    fs.unlinkSync(path.join(
        subject.sourceRoot,
        "utility/space/default/index.js",
    ));

    try
    {
        materializeGeneratedPackaging(subject.plan);
        const compatibility = path.join(
            subject.outputRoot,
            "utility/space/default/js/default.js",
        );

        assert.equal(fs.statSync(compatibility).size, 0);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("Core packaging materializes a deterministic source-backed rule manifest", () => {
    const subject = fixture();
    const coreInput = writeFile(subject.sourceRoot, "core/index.js", "");
    writeFile(
        subject.outputRoot,
        ".compat/utility-full/css/utility.full.css",
        ".logical { margin-inline-start: 1rem; }\n",
    );
    writeFile(
        subject.sourceRoot,
        "component/modal/rule.js",
        "SF.RuleLoader.modal = { regex: /sf-modal/i, type: 'component', css: true };\n",
    );
    writeFile(
        subject.sourceRoot,
        "utility/display/default/rule.js",
        "SF.RuleLoader['display/default'] = /(?:^|\\s)block(?:\\s|$)/;\n",
    );
    subject.plan.entries = [{
        input: coreInput,
        key: "core",
        outputDirectory: path.join(subject.outputRoot, "core"),
        target: "core",
    }];

    try
    {
        const result = materializeGeneratedPackaging(subject.plan);
        const manifest = JSON.parse(fs.readFileSync(path.join(
            subject.outputRoot,
            "rule/rule.json",
        )));

        assert.deepEqual(manifest, [{
            name: "display/default",
            regex: "/(?:^|\\s)block(?:\\s|$)/",
        }, {
            css: true,
            name: "modal",
            regex: "/sf-modal/i",
            type: "component",
        }]);
        assert.equal(result.ruleManifests.length, 1);
        assert.equal(result.aggregateAssets.length, 1);
        assert.equal(fs.readFileSync(path.join(
            subject.outputRoot,
            "core/css/utility.full.css",
        ), "utf8"), ".logical { margin-inline-start: 1rem; }\n");
        assert.equal(fs.existsSync(path.join(subject.outputRoot, ".compat")), false);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("non-empty uncompiled compatibility JS fails closed", () => {
    const subject = fixture();
    writeFile(subject.sourceRoot, "utility/space/default/index.js", "sideEffect();\n");

    try
    {
        assert.throws(
            () => materializeGeneratedPackaging(subject.plan),
            /uncompiled compatibility script is not stylesheet-only/,
        );
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("source and output symlinks fail closed", () => {
    const sourceSubject = fixture();
    const outside = writeFile(sourceSubject.workspace, "outside.json", "{}\n");
    fs.symlinkSync(outside, path.join(
        sourceSubject.sourceRoot,
        "utility/space/default/link.json",
    ));

    try
    {
        assert.throws(
            () => materializeGeneratedPackaging(sourceSubject.plan),
            /source asset tree contains a symlink/,
        );
    }
    finally
    {
        fs.rmSync(sourceSubject.workspace, { force: true, recursive: true });
    }

    const outputSubject = fixture();
    fs.symlinkSync(outside, path.join(
        outputSubject.outputRoot,
        "utility/space/default/css/link.css",
    ));

    try
    {
        assert.throws(
            () => materializeGeneratedPackaging(outputSubject.plan),
            /generated output tree contains a symlink/,
        );
    }
    finally
    {
        fs.rmSync(outputSubject.workspace, { force: true, recursive: true });
    }
});

test("a shipped module whose relative import the distribution does not hold fails the build", () => {
    const { assertShippedModuleImports } = require("../../libs/generatedPackaging");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-imports-"));
    const dir = path.join(root, "core/js/composition");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "here.mjs"), "export const here = 1;\n");
    const good = path.join(dir, "index.mjs");
    fs.writeFileSync(good, "import { here } from './here.mjs';\nexport { here };\n");
    assert.doesNotThrow(() => assertShippedModuleImports(root, [good]));
    const bad = path.join(dir, "recipe.mjs");
    fs.writeFileSync(bad, "import { isSchema } from '../schema-name.mjs';\nexport { isSchema };\n");
    assert.throws(() => assertShippedModuleImports(root, [good, bad]), /recipe\.mjs imports \.\.\/schema-name\.mjs/u);
});

test("what a shipped module imports by a relative path ships with it", () => {
    const { materializeSourceAssets } = require("../../libs/generatedPackaging");
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "closure-src-"));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "closure-out-"));
    fs.mkdirSync(path.join(sourceRoot, "core/js/composition"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "core/js/page-language.js"), "export const pageText = () => '';\n");
    fs.writeFileSync(path.join(sourceRoot, "core/js/composition/overlay.mjs"), "import { pageText } from '../page-language.js';\nexport { pageText };\n");
    fs.writeFileSync(path.join(sourceRoot, "core/js/composition/entry.js"), "");
    const copied = materializeSourceAssets({ sourceRoot, outputRoot, entries: [{ key: "core/composition", input: path.join(sourceRoot, "core/js/composition/entry.js") }] });
    assert.ok(fs.existsSync(path.join(outputRoot, "core/js/composition/overlay.mjs")), "the module itself ships");
    assert.ok(fs.existsSync(path.join(outputRoot, "core/js/page-language.js")), "the imported script ships");
    assert.ok(copied.some((file) => file.endsWith("page-language.js")));
});

test("a host port's conformance kit ships whole and its digest recomputes without the .gz files", () => {
    const subject = fixture();
    const edition = "core/contracts/ports/simai.example-port/1.0.0/";
    const input = writeFile(subject.sourceRoot, "core/index.js", "export {};\n");
    const files = {
        "README.md": "# Conformance kit\n",
        "manifest.json": "{\"version\":\"1.0.0\",\"cases\":[\"one\"]}\n",
        "cases/one.json": "{\"id\":\"one\"}\n",
    };
    const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
    const digest = sha256(Object.entries(files)
        .map(([relative, content]) => `${relative} ${sha256(content)}\n`)
        .sort()
        .join(""));

    for (const [relative, content] of Object.entries(files))
    {
        writeFile(subject.sourceRoot, `${edition}kit/${relative}`, content);
    }

    writeFile(subject.sourceRoot, `${edition}port.json`, JSON.stringify({
        version: "1.0.0",
        conformance: { kit: "kit", sha256: digest, cases: 1 },
    }));
    subject.plan.entries = [{ input, key: "core", target: "core",
        outputDirectory: path.join(subject.outputRoot, "core") }];
    writeFile(subject.outputRoot, ".compat/utility-full/css/utility.full.css", "");

    try
    {
        materializeGeneratedPackaging(subject.plan);
        const kit = path.join(subject.outputRoot, `${edition}kit`);

        assert.equal(fs.readFileSync(path.join(kit, "README.md"), "utf8"), files["README.md"]);
        assert.equal(fs.existsSync(path.join(kit, "manifest.json.gz")), true);
        assert.equal(portKitDigest(kit, { skipGzip: true }), digest);
        assert.notEqual(portKitDigest(kit), digest);

        fs.writeFileSync(path.join(kit, "README.md"), "changed\n");
        assert.throws(() => assertShippedPortKits(subject.outputRoot), /shipped port kit does not give its pinned digest/);

        fs.writeFileSync(path.join(subject.sourceRoot, `${edition}kit/README.md`), "changed\n");
        assert.throws(() => materializeGeneratedPackaging(subject.plan), /port kit does not give its pinned digest: core\/contracts\/ports\/simai.example-port\/1.0.0/);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});
test("every sheet that uses the sf layers declares their order before its first rule", () => {
    const subject = fixture();
    const order = "@layer sf.reset, sf.tokens, sf.base, sf.utilities, sf.components, sf.overrides, sf.states;";
    writeFile(subject.sourceRoot, "core/scss/_sf_layer_order.scss", `// keep first\n${order}\n`);
    const component = writeFile(subject.outputRoot, "utility/space/default/css/layered.css",
        "@charset \"UTF-8\";\n@layer sf.components{.a{margin:0}}\n");
    const minified = writeFile(subject.outputRoot, "utility/space/default/css/core.min.css",
        "@layer sf.reset,sf.tokens,sf.base,sf.utilities,sf.components,sf.overrides,sf.states;@layer sf.base{ol{margin:1rem}}");
    const plain = writeFile(subject.outputRoot, "utility/space/default/css/plain.css", ".b{color:red}\n");

    try
    {
        const result = materializeGeneratedPackaging(subject.plan);

        assert.equal(fs.readFileSync(component, "utf8"),
            `@charset "UTF-8";\n${order}\n@layer sf.components{.a{margin:0}}\n`);
        assert.equal(fs.readFileSync(minified, "utf8").startsWith("@layer sf.reset,sf.tokens,"), true);
        assert.equal(fs.readFileSync(plain, "utf8"), ".b{color:red}\n");
        assert.deepEqual(result.layerOrder, [fs.realpathSync(component)]);
        assert.deepEqual(zlib.gunzipSync(fs.readFileSync(`${component}.gz`)), fs.readFileSync(component));

        // A second pass changes nothing: the order is declared once.
        materializeGeneratedPackaging(subject.plan);
        assert.equal(fs.readFileSync(component, "utf8").split(order).length, 2);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});

test("a source without the sf layer order leaves every sheet as built", () => {
    const subject = fixture();
    const sheet = writeFile(subject.outputRoot, "utility/space/default/css/layered.css", "@layer sf.components{.a{margin:0}}\n");

    try
    {
        const result = materializeGeneratedPackaging(subject.plan);

        assert.equal(fs.readFileSync(sheet, "utf8"), "@layer sf.components{.a{margin:0}}\n");
        assert.deepEqual(result.layerOrder, []);
    }
    finally
    {
        fs.rmSync(subject.workspace, { force: true, recursive: true });
    }
});
