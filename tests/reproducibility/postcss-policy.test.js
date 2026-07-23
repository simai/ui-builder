"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const postcss = require("postcss");
const postcssPresetEnv = require("postcss-preset-env");

const {
    LOGICAL_PROPERTIES_FEATURE,
    assertRtlSafePostcssPlugins,
    createPostcssOptions,
    createPostcssPlugins,
    createPostcssPresetEnvOptions,
} = require("../../libs/postcssPolicy");

const FIXTURE_DECLARATIONS = [
    "margin-inline-start: 1rem",
    "padding-inline-end: 2rem",
    "inset-inline-end: 3rem",
    "border-inline-start-width: 4px",
];
const FIXTURE = `.fixture { ${FIXTURE_DECLARATIONS.join("; ")}; }`;

const LEGACY_POLICY_CARRIERS = [
    "_webpack.core.js",
    "_webpack.core.min.js",
    "component.webpack.js",
    "component.min.webpack.js",
    "core.webpack.js",
    "core.min.webpack.js",
    "utility.webpack.js",
    "utility.min.webpack.js",
    "webpack.editorjs.js",
    "webpack.editorjs.min.js",
];

function policyOptions(overrides = {})
{
    return createPostcssPresetEnvOptions({
        autoprefixer: {
            backgroundColor: false,
            borderColor: false,
            color: false,
            position: true,
        },
        browsers: "last 1 version, >1%",
        ...overrides,
    });
}

async function transform(input)
{
    return postcss([
        postcssPresetEnv(policyOptions()),
    ]).process(input, { from: undefined });
}

test("logical preservation is mandatory and caller options stay isolated", () => {
    const caller = {
        autoprefixer: {
            position: true,
        },
        features: {
            [LOGICAL_PROPERTIES_FEATURE]: {
                preserve: false,
            },
            "nesting-rules": false,
        },
    };
    const options = createPostcssPresetEnvOptions(caller);

    assert.equal(
        options.features[LOGICAL_PROPERTIES_FEATURE].preserve,
        true,
    );
    assert.equal(options.features["nesting-rules"], false);
    assert.notEqual(options, caller);
    assert.notEqual(options.autoprefixer, caller.autoprefixer);
    assert.notEqual(options.features, caller.features);
    assert.equal(caller.features[LOGICAL_PROPERTIES_FEATURE].preserve, false);
});

test("plugin and loader helpers always expose the RTL-safe contract", () => {
    const plugins = createPostcssPlugins({ browsers: "last 2 versions" });
    const postcssOptions = createPostcssOptions({
        browsers: "last 2 versions",
    });

    assert.equal(assertRtlSafePostcssPlugins(plugins), true);
    assert.equal(assertRtlSafePostcssPlugins(postcssOptions.plugins), true);
    assert.throws(
        () => assertRtlSafePostcssPlugins([["postcss-preset-env", {}]]),
        /must preserve logical-properties-and-values/,
    );
});

test("normal and compact inputs retain logical declarations after fallbacks", async () => {
    for (const input of [FIXTURE, FIXTURE.replaceAll(" ", "")])
    {
        const result = await transform(input);

        assert.match(result.css, /\[dir="ltr"\]/);
        assert.match(result.css, /\[dir="rtl"\]/);
        assert.match(result.css, /margin-left:\s*1rem/);
        assert.match(result.css, /margin-right:\s*1rem/);
        assert.match(result.css, /padding-right:\s*2rem/);
        assert.match(result.css, /padding-left:\s*2rem/);
        assert.match(result.css, /right:\s*3rem/);
        assert.match(result.css, /left:\s*3rem/);
        assert.match(result.css, /border-left-width:\s*4px/);
        assert.match(result.css, /border-right-width:\s*4px/);

        for (const declaration of FIXTURE_DECLARATIONS)
        {
            const [property, value] = declaration.split(": ");

            assert.ok(
                new RegExp(`${property}:\\s*${value}`).test(result.css),
                `retained declaration missing: ${declaration}`,
            );
        }

        const marginLogical = result.css.search(/margin-inline-start:\s*1rem/);
        const paddingLogical = result.css.search(/padding-inline-end:\s*2rem/);

        assert.ok(
            marginLogical > result.css.search(/margin-left:\s*1rem/),
        );
        assert.ok(
            paddingLogical > result.css.search(/padding-right:\s*2rem/),
        );
    }
});

test("every legacy style carrier delegates to the centralized policy", () => {
    const root = path.resolve(__dirname, "../..");

    for (const relativePath of LEGACY_POLICY_CARRIERS)
    {
        const source = fs.readFileSync(
            path.join(root, relativePath),
            "utf8",
        );

        assert.match(
            source,
            /require\(['"]\.\/libs\/postcssPolicy['"]\)/,
            relativePath,
        );
        assert.match(source, /createPostcssOptions\(/, relativePath);
        assert.doesNotMatch(source, /["']postcss-preset-env["']/, relativePath);
    }

    const rootConfig = fs.readFileSync(
        path.join(root, "postcss.config.js"),
        "utf8",
    );
    const lifecycle = fs.readFileSync(
        path.join(root, "libs/componentBuildLifecycle.js"),
        "utf8",
    );

    assert.match(rootConfig, /createPostcssPresetEnvOptions\(/);
    assert.match(lifecycle, /createPostcssPlugins\(/);
});
