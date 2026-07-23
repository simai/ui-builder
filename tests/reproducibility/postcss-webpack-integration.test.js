"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const webpack = require("webpack");
const RemoveEmptyScriptsPlugin = require("webpack-remove-empty-scripts");

const {
    DEFAULT_TARGETS,
} = require("../../libs/buildPlan");
const {
    createPostcssPlugins,
} = require("../../libs/postcssPolicy");
const {
    createWebpackBuildDefinition,
} = require("../../libs/webpackConfigFactory");
const {
    configureProductConfigurations,
} = require("../../libs/productWebpackRuntime");

const INPUT = [
    ".fixture {",
    "  margin-inline-start: 1rem;",
    "  padding-inline-end: 2rem;",
    "  inset-inline-end: 3rem;",
    "  border-inline-start-width: 4px;",
    "}",
    "",
].join("\n");
const TARGET_NAMES = ["component", "core", "smart", "utility"];
const OUTPUT_PREFIXES = [
    "component/fixture/css/fixture",
    "core/css/core",
    "smart/fixture/css/fixture",
    "utility/fixture/css/fixture",
];

function sha256(value)
{
    return crypto.createHash("sha256").update(value).digest("hex");
}

function configurationPolicy()
{
    return {
        devtool: false,
        output: {
            pathinfo: false,
        },
        postcss: {
            plugins: createPostcssPlugins({
                autoprefixer: {
                    backgroundColor: false,
                    borderColor: false,
                    color: false,
                    position: true,
                },
                browsers: "last 1 version, >1%",
            }),
        },
        resolveExtensions: [".js", ".scss"],
        target: "web",
    };
}

function runCompiler(configurations)
{
    return new Promise((resolve, reject) => {
        const compiler = webpack(configurations);

        compiler.run((runError, stats) => {
            const statsError = !runError && stats && stats.hasErrors()
                ? new Error(stats.toString({ all: false, errors: true }))
                : null;

            compiler.close(closeError => {
                if (runError || statsError || closeError)
                {
                    reject(runError || statsError || closeError);

                    return;
                }

                resolve();
            });
        });
    });
}

function assertRtlSafeOutput(css, label)
{
    assert.match(css, /\[dir="ltr"\]/, label);
    assert.match(css, /\[dir="rtl"\]/, label);
    assert.match(css, /margin-inline-start:\s*1rem/, label);
    assert.match(css, /padding-inline-end:\s*2rem/, label);
    assert.match(css, /inset-inline-end:\s*3rem/, label);
    assert.match(css, /border-inline-start-width:\s*4px/, label);
    assert.ok(
        css.search(/margin-inline-start:\s*1rem/)
            > css.search(/margin-left:\s*1rem/),
        label,
    );
    assert.ok(
        css.search(/margin-inline-start:\s*1rem/)
            > css.search(/margin-right:\s*1rem/),
        label,
    );
}

async function buildOnce()
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-rtl-webpack-"));
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");

    try
    {
        for (const targetName of ["component", "smart", "utility"])
        {
            const input = path.join(
                sourceRoot,
                targetName,
                "fixture",
                "index.scss",
            );
            fs.mkdirSync(path.dirname(input), { recursive: true });
            fs.writeFileSync(input, INPUT);
        }

        const core = path.join(sourceRoot, "core");
        fs.mkdirSync(core, { recursive: true });
        fs.writeFileSync(path.join(core, "index.js"), 'require("./style.scss");\n');
        fs.writeFileSync(path.join(core, "rule.js"), "module.exports = {};\n");
        fs.writeFileSync(path.join(core, "style.scss"), INPUT);

        const targets = DEFAULT_TARGETS.filter(target =>
            TARGET_NAMES.includes(target.name));
        const definition = createWebpackBuildDefinition({
            configurationPoliciesByTarget: Object.fromEntries(
                TARGET_NAMES.map(name => [name, configurationPolicy()]),
            ),
            outputRoot,
            sassResourcesByTarget: Object.fromEntries(
                TARGET_NAMES.map(name => [name, []]),
            ),
            sourceRoot,
            targets,
        }, {
            MiniCssExtractPlugin,
            RemoveEmptyScriptsPlugin,
            TerserPlugin,
        });

        const builderRoot = path.resolve(__dirname, "../..");
        configureProductConfigurations(definition.configurations, {
            builderDependencyRoot: builderRoot,
            builderRoot,
            sourceDependencyRoot: sourceRoot,
            sourceRoot,
        });

        await runCompiler(definition.configurations);

        const result = {};

        for (const outputPrefix of OUTPUT_PREFIXES)
        {
            for (const suffix of ["", ".min"])
            {
                const relative = `${outputPrefix}${suffix}.css`;
                const css = fs.readFileSync(path.join(outputRoot, relative), "utf8");

                assertRtlSafeOutput(css, relative);
                result[relative] = sha256(css);
            }
        }

        return result;
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
}

test("two clean real Webpack builds preserve Core, Utility, Component and Smart policy", async () => {
    const first = await buildOnce();
    const second = await buildOnce();

    assert.deepEqual(first, second);
    assert.equal(Object.keys(first).length, 8);
});
