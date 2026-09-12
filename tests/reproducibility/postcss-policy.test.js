"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const postcss = require("postcss");
const postcssPresetEnv = require("postcss-preset-env");
const lateLogicalFallbacks = require(
    "../../libs/postcssLateLogicalFallbacks",
);

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
        lateLogicalFallbacks(),
    ]).process(input, { from: undefined });
}

const VARIABLE_FIXTURE = [
    ".variable {",
    "  border-inline-start-width: var(--border-width, 0);",
    "  border-inline-end-color: var(--border-color, red);",
    "  margin-inline-start: var(--margin, 1rem);",
    "  padding-inline-end: var(--padding, 2rem);",
    "  inset-inline-end: var(--position, 3rem);",
    "  color: var(--text-color, blue);",
    "}",
    "[dir=\"ltr\"] .intentional { color: red; color: var(--color, red); }",
    "[dir=\"ltr\"] .intentional { color: green; }",
].join("\n");

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
            "dir-pseudo-class": { preserve: false },
        },
    };
    const options = createPostcssPresetEnvOptions(caller);

    assert.equal(
        options.features[LOGICAL_PROPERTIES_FEATURE].preserve,
        true,
    );
    assert.equal(options.features["nesting-rules"], false);
    assert.equal(options.features["dir-pseudo-class"], false);
    assert.deepEqual(caller.features["dir-pseudo-class"], { preserve: false });
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
    assert.throws(
        () => assertRtlSafePostcssPlugins([["postcss-preset-env", {
            features: {
                [LOGICAL_PROPERTIES_FEATURE]: { preserve: true },
                "dir-pseudo-class": false,
            },
        }]]),
        /must remove late generated logical fallbacks/,
    );
});

test("normal and compact inputs retain logical declarations after fallbacks", async () => {
    for (const input of [FIXTURE, FIXTURE.replaceAll(" ", "")])
    {
        const result = await transform(input);

        assert.match(result.css, /@supports not \(margin-inline-start: initial\)/);
        assert.match(result.css, /_:-ms-input-placeholder,/);
        assert.match(result.css, /:dir\(ltr\)/);
        assert.match(result.css, /:dir\(rtl\)/);
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

test("late generated fallbacks cannot override variable-powered LTR and RTL rules", async () => {
    const result = await transform(VARIABLE_FIXTURE);
    const css = result.css;

    for (const [property, fallback, variable] of [
        ["border-left-width", "0", "--border-width"],
        ["border-right-width", "0", "--border-width"],
        ["border-right-color", "red", "--border-color"],
        ["border-left-color", "red", "--border-color"],
        ["margin-left", "1rem", "--margin"],
        ["margin-right", "1rem", "--margin"],
        ["padding-right", "2rem", "--padding"],
        ["padding-left", "2rem", "--padding"],
        ["right", "3rem", "--position"],
        ["left", "3rem", "--position"],
    ])
    {
        const paired = new RegExp(
            `${property}:\\s*${fallback};\\s*${property}:\\s*var\\(${variable},\\s*${fallback}\\)`,
        );
        const lateFallback = new RegExp(
            `${property}:\\s*${fallback};?\\s*\\}`,
            "g",
        );

        assert.match(css, paired, `${property} must keep fallback before var()`);
        assert.equal(
            [...css.matchAll(lateFallback)].length,
            0,
            `${property} must not be reset by a later generated fallback`,
        );
    }

    assert.match(css, /color:\s*blue;\s*color:\s*var\(--text-color,\s*blue\)/);
    assert.match(css, /\.intentional\s*\{\s*color:\s*green/);
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

    assert.match(rootConfig, /createPostcssPlugins\(/);
    assert.match(lifecycle, /createPostcssPlugins\(/);
});


test("native direction cannot be disabled by an unsafe plugin tuple", () => {
    const plugins = createPostcssPlugins();
    delete plugins[0][1].features["dir-pseudo-class"];
    assert.throws(() => assertRtlSafePostcssPlugins(plugins), /native :dir/);
});

test("negative calc fallback is retained before var and never repeated later", async () => {
    const result = await transform(".negative { margin-inline-start: calc(-1 * var(--space, 11px)); }");
    assert.equal(lateLogicalFallbacks.varFallback("calc(-1 * var(--space, 11px))"), "calc(-1 * 11px)");
    assert.equal(lateLogicalFallbacks.varFallback("calc(-1 * var(--space))"), null);
    assert.equal(lateLogicalFallbacks.varFallback("calc(var(--a, 1px) + var(--b))"), null);
    for (const direction of ["ltr", "rtl"])
    {
        const rules = result.root.nodes.filter(rule => rule.selector === `.negative:where(:dir(${direction}))`);
        assert.equal(rules.length, 1);
        assert.deepEqual(rules[0].nodes.map(node => node.value), [
            "calc(-1 * 11px)", "calc(-1 * var(--space, 11px))",
        ]);
    }
});


test("legacy physical rules are available without :dir or @supports", async () => {
    const result = await transform(FIXTURE);
    const ie = [];
    const featureQueries = [];
    result.root.walkRules(rule => {
        if (rule.selector.startsWith("_:-ms-input-placeholder,")) ie.push(rule);
        if (rule.parent.type === "atrule" && rule.parent.name === "supports") featureQueries.push(rule);
    });
    assert.equal(ie.length, 8);
    assert.equal(featureQueries.length, 8);
    for (const rule of ie)
    {
        assert.equal(rule.parent.type, "root", "IE must not depend on @supports");
        assert.doesNotMatch(rule.selector, /:dir|:where/);
        assert.ok(rule.nodes.every(node => !node.prop.includes("inline")));
    }
    for (const rule of featureQueries)
    {
        assert.match(rule.parent.params, /^not \(/);
        assert.doesNotMatch(rule.selector, /:dir|:where/);
    }
    result.root.walkDecls(decl => assert.doesNotMatch(decl.value, /^(initial|unset|revert|revert-layer)$/));
    assert.match(result.css, /:where\(:dir\(ltr\)\)/);
});

test("multiline legacy selector lists have clean line endings", async () => {
    const result = await transform([
        ".group:dir(ltr) .first,",
        ".group:dir(ltr) .second { margin-left: 1rem; margin-inline-start: 1rem; }",
    ].join("\n"));

    assert.doesNotMatch(result.css, /[ \t]+(?:\r?\n|$)/);
    assert.match(
        result.css,
        /html:not\(\[dir="rtl"\]\) \.group \.first,html:not\(\[dir="rtl"\]\)\n\.group \.second/,
    );
});
