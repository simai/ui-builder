#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const postcss = require("postcss");
const postcssPresetEnv = require("postcss-preset-env");

const {
    createPostcssPresetEnvOptions,
} = require("../../libs/postcssPolicy");

const DECLARATIONS = [
    ["margin-inline-start", "1rem", "margin-left", "margin-right"],
    ["padding-inline-end", "2rem", "padding-right", "padding-left"],
    ["inset-inline-end", "3rem", "right", "left"],
    [
        "border-inline-start-width",
        "4px",
        "border-left-width",
        "border-right-width",
    ],
];
const INPUT = `.fixture { ${DECLARATIONS.map(([property, value]) =>
    `${property}: ${value}`).join("; ")}; }`;

function sha256(value)
{
    return crypto.createHash("sha256").update(value).digest("hex");
}

function checkOutput(css)
{
    const checks = {
        directionFallbacks: /\[dir="ltr"\]/.test(css)
            && /\[dir="rtl"\]/.test(css),
        logicalRetained: true,
        logicalAfterFallbacks: true,
        physicalFallbacks: true,
    };

    for (const [logical, value, ltrProperty, rtlProperty] of DECLARATIONS)
    {
        const logicalIndex = css.search(new RegExp(`${logical}:\\s*${value}`));
        const ltrIndex = css.search(new RegExp(`${ltrProperty}:\\s*${value}`));
        const rtlIndex = css.search(new RegExp(`${rtlProperty}:\\s*${value}`));

        checks.logicalRetained &&= logicalIndex >= 0;
        checks.physicalFallbacks &&= ltrIndex >= 0 && rtlIndex >= 0;
        checks.logicalAfterFallbacks &&= logicalIndex > ltrIndex
            && logicalIndex > rtlIndex;
    }

    return checks;
}

async function transform(input)
{
    const options = createPostcssPresetEnvOptions({
        autoprefixer: {
            backgroundColor: false,
            borderColor: false,
            color: false,
            position: true,
        },
        browsers: "last 1 version, >1%",
    });
    const result = await postcss([
        postcssPresetEnv(options),
    ]).process(input, { from: undefined });

    return result.css;
}

async function main()
{
    const variants = [];

    for (const [name, input] of [
        ["normal", INPUT],
        ["compact", INPUT.replaceAll(" ", "")],
    ])
    {
        const output = await transform(input);
        const checks = checkOutput(output);

        variants.push({
            checks,
            input_sha256: sha256(input),
            name,
            output_sha256: sha256(output),
            pass: Object.values(checks).every(Boolean),
        });
    }

    const report = {
        schema_version: "1.0.0",
        operation_id: "simai.framework.verify_rtl_postcss_policy",
        node_version: process.version,
        policy: {
            feature: "logical-properties-and-values",
            preserve: true,
        },
        variants,
        verdict: variants.every(variant => variant.pass) ? "PASS" : "FAIL",
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.verdict === "PASS" ? 0 : 1;
}

main().catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
});
