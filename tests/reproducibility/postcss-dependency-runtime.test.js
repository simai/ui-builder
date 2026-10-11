"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const postcss = require("postcss");
const cleanup = require("../../libs/postcssLateLogicalFallbacks");

const DIRECTIONAL_INPUT = ".a:dir(rtl) { margin-left: 1px; }\n";

function writeFile(root, relative, contents)
{
    const target = path.join(root, relative);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}

function withRuntime(t, populate)
{
    const runtimeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "sf-postcss-runtime-"),
    );
    const previous = process.env.SF_BUILDER_DEPENDENCY_ROOT;

    writeFile(runtimeRoot, "package.json", "{}\n");
    populate(runtimeRoot);
    process.env.SF_BUILDER_DEPENDENCY_ROOT = runtimeRoot;
    t.after(() => {
        if (previous === undefined)
        {
            delete process.env.SF_BUILDER_DEPENDENCY_ROOT;
        }
        else
        {
            process.env.SF_BUILDER_DEPENDENCY_ROOT = previous;
        }
        fs.rmSync(runtimeRoot, { force: true, recursive: true });
    });

    return runtimeRoot;
}

test("direction fallbacks come from the frozen dependency runtime", async t => {
    const runtimeRoot = withRuntime(t, root => {
        writeFile(
            root,
            "node_modules/postcss-preset-env/package.json",
            "{\"name\":\"postcss-preset-env\",\"main\":\"index.js\"}\n",
        );
        writeFile(
            root,
            "node_modules/postcss-preset-env/index.js",
            "module.exports = () => ({ postcssPlugin: \"preset\" });\n",
        );
        writeFile(
            root,
            "node_modules/postcss-dir-pseudo-class/package.json",
            "{\"name\":\"postcss-dir-pseudo-class\",\"main\":\"index.js\"}\n",
        );
        writeFile(
            root,
            "node_modules/postcss-dir-pseudo-class/index.js",
            [
                "module.exports = options => ({",
                "    Rule(rule) {",
                "        rule.selector = `.runtime-${options.dir}`;",
                "    },",
                "});",
                "",
            ].join("\n"),
        );
    });

    const result = await postcss([cleanup()]).process(DIRECTIONAL_INPUT, {
        from: path.join(runtimeRoot, "fixture.css"),
    });

    assert.match(result.css, /\.runtime-ltr/);
    assert.equal(cleanup.builderDependencyRoot(), runtimeRoot);
});

test("a runtime without the PostCSS preset fails with a clear error", t => {
    const runtimeRoot = withRuntime(t, () => {});

    assert.throws(() => cleanup(), error => {
        assert.match(error.message, /lacks postcss-preset-env/);
        assert.ok(error.message.includes(runtimeRoot));

        return true;
    });
});

test("a relative dependency runtime root is refused", () => {
    assert.throws(
        () => cleanup.builderDependencyRoot({
            SF_BUILDER_DEPENDENCY_ROOT: "relative/runtime",
        }),
        /must be an absolute path/,
    );
});
