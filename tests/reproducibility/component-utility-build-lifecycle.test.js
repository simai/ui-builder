"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    runComponentBuild,
    runUtilityBuild,
} = require("../../libs/componentBuildLifecycle");

const PRODUCT_RUNNER = path.resolve(
    __dirname,
    "../../scripts/run-component-utility-product-build.cjs",
);

class MiniCssExtractPluginStub
{
    static loader = "mini-css-extract-loader-stub";

    constructor(options)
    {
        this.options = options;
    }
}

class RemoveEmptyScriptsPluginStub {}
class TerserPluginStub {}

const ADAPTERS = Object.freeze({
    MiniCssExtractPlugin: MiniCssExtractPluginStub,
    RemoveEmptyScriptsPlugin: RemoveEmptyScriptsPluginStub,
    TerserPlugin: TerserPluginStub,
});

function writeFile(root, relativePath, content)
{
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
}

function runProductRunner(argumentsList, environment = {})
{
    return spawnSync(process.execPath, [PRODUCT_RUNNER, ...argumentsList], {
        encoding: "utf8",
        env: { ...process.env, ...environment },
    });
}

test("Component/Utility runner rejects a relative dependency runtime", () => {
    const result = runProductRunner(
        ["component", "/a", "/b", "/c", "/d"],
        { SF_BUILDER_DEPENDENCY_ROOT: "relative" },
    );

    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, "DEPENDENCY_ROOT_NOT_ABSOLUTE");
});

function invocationDiagnostic(argumentsList)
{
    const result = runProductRunner(argumentsList);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE|\n\s+at\s/);
    return JSON.parse(result.stderr.trim());
}

test("Component/Utility runner rejects invalid products and paths", () => {
    assert.equal(invocationDiagnostic([]).code, "INVALID_ARGUMENT_COUNT");
    assert.deepEqual(
        invocationDiagnostic(["smart", "/a", "/b", "/c", "/d"]),
        {
            code: "INVALID_PRODUCT",
            details: { product: "smart" },
            message: "product must be component or utility",
            phase: "invocation",
            schemaVersion: 1,
            status: 2,
        },
    );
    assert.deepEqual(
        invocationDiagnostic(["utility", "/a", "b", "/c", "d"]).details,
        {
            invalidArguments: [
                { index: 2, name: "sourceRoot" },
                { index: 4, name: "diagnosticsPath" },
            ],
        },
    );
});

for (const [product, lifecycleName] of [
    ["component", "runComponentBuild"],
    ["utility", "runUtilityBuild"],
])
{
    test(`${product} product runner selects only its lifecycle`, () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `sf-${product}-runner-`));
        const builderRoot = path.join(workspace, "builder");
        const sourceRoot = path.join(workspace, "source");
        const outputRoot = path.join(workspace, "output");
        const diagnosticsPath = path.join(workspace, "diagnostics.json");

        writeFile(builderRoot, "package.json", "{}\n");
        writeFile(
            builderRoot,
            "libs/componentBuildLifecycle.js",
            `exports.${lifecycleName} = async (options, runtime) => {
    runtime.reportDiagnostic({ phase: "fixture", options });
    return 0;
};\n`,
        );
        writeFile(
            builderRoot,
            "node_modules/webpack/index.js",
            "module.exports = function webpack() {};\n",
        );
        for (const moduleName of [
            "mini-css-extract-plugin",
            "terser-webpack-plugin",
            "webpack-remove-empty-scripts",
        ])
        {
            writeFile(
                builderRoot,
                `node_modules/${moduleName}/index.js`,
                "module.exports = class AdapterStub {};\n",
            );
        }

        try
        {
            const result = runProductRunner([
                product,
                builderRoot,
                sourceRoot,
                outputRoot,
                diagnosticsPath,
            ]);

            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")), {
                diagnostics: [{
                    options: { outputRoot, sourceRoot },
                    phase: "fixture",
                }],
                product,
                status: 0,
            });
        }
        finally
        {
            fs.rmSync(workspace, { force: true, recursive: true });
        }
    });
}

test("Component runner resolves build dependencies from a disposable runtime", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-component-runtime-"));
    const builderRoot = path.join(workspace, "builder");
    const runtimeRoot = path.join(workspace, "runtime");
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");
    const diagnosticsPath = path.join(workspace, "diagnostics.json");
    const configurationPath = path.join(workspace, "configuration.json");

    writeFile(builderRoot, "package.json", "{}\n");
    writeFile(
        builderRoot,
        "libs/componentBuildLifecycle.js",
        `exports.runComponentBuild = async (options, runtime) => {
    runtime.webpack([{ resolve: { extensions: [".js"] } }]);
    return 0;
};\n`,
    );
    writeFile(runtimeRoot, "package.json", "{}\n");
    writeFile(
        runtimeRoot,
        "node_modules/webpack/index.js",
        `module.exports = configurations => {
    require("node:fs").writeFileSync(
        process.env.SF_CONFIG_CAPTURE,
        JSON.stringify(configurations),
    );
    return {};
};\n`,
    );
    for (const moduleName of [
        "mini-css-extract-plugin",
        "terser-webpack-plugin",
        "webpack-remove-empty-scripts",
    ])
    {
        writeFile(
            runtimeRoot,
            `node_modules/${moduleName}/index.js`,
            "module.exports = class AdapterStub {};\n",
        );
    }

    try
    {
        const result = runProductRunner([
            "component",
            builderRoot,
            sourceRoot,
            outputRoot,
            diagnosticsPath,
        ], {
            SF_BUILDER_DEPENDENCY_ROOT: runtimeRoot,
            SF_CONFIG_CAPTURE: configurationPath,
            SF_SOURCE_DEPENDENCY_ROOT: runtimeRoot,
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")).status, 0);
        const [configuration] = JSON.parse(
            fs.readFileSync(configurationPath, "utf8"),
        );
        assert.equal(configuration.optimization.chunkIds, false);
        assert.equal(configuration.optimization.moduleIds, false);
        assert.equal(configuration.plugins.length, 1);
        const expectedRoots = [];
        const seenRoots = new Set();
        for (const [root, replacement] of [
            [runtimeRoot, "<sf:builder-dependencies>"],
            [builderRoot, "<sf:builder-source>"],
            [sourceRoot, "<sf:product-source>"],
        ])
        {
            const rootCandidates = [path.resolve(root)];
            try
            {
                rootCandidates.push(fs.realpathSync.native(root));
            }
            catch (error)
            {
                assert.equal(error.code, "ENOENT");
            }
            for (const candidate of rootCandidates)
            {
                if (!seenRoots.has(candidate))
                {
                    seenRoots.add(candidate);
                    expectedRoots.push([candidate, replacement]);
                }
            }
        }
        expectedRoots.sort((left, right) => right[0].length - left[0].length);
        assert.deepEqual(
            configuration.plugins[0].roots,
            expectedRoots,
        );
        assert.equal(
            configuration.resolveLoader.modules[0],
            path.join(runtimeRoot, "node_modules"),
        );
        assert.equal(
            configuration.resolve.modules[0],
            path.join(runtimeRoot, "node_modules"),
        );
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});

test("Utility runner fails closed when the source alias contract verifier fails", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-utility-alias-preflight-"));
    const builderRoot = path.join(workspace, "builder");
    const sourceRoot = path.join(workspace, "source", "src");
    const outputRoot = path.join(workspace, "output");
    const diagnosticsPath = path.join(workspace, "diagnostics.json");

    writeFile(builderRoot, "package.json", "{}\n");
    writeFile(
        builderRoot,
        "libs/componentBuildLifecycle.js",
        "exports.runUtilityBuild = async () => { throw new Error('must not build'); };\n",
    );
    writeFile(builderRoot, "node_modules/webpack/index.js", "module.exports = () => {};\n");
    for (const moduleName of [
        "mini-css-extract-plugin",
        "terser-webpack-plugin",
        "webpack-remove-empty-scripts",
    ])
    {
        writeFile(
            builderRoot,
            `node_modules/${moduleName}/index.js`,
            "module.exports = class AdapterStub {};\n",
        );
    }
    writeFile(
        sourceRoot,
        "core/contracts/utility-module-aliases.v1.json",
        "{}\n",
    );
    writeFile(
        path.resolve(sourceRoot, "../scripts"),
        "verify-utility-module-aliases.mjs",
        "process.stderr.write('fixture alias mismatch'); process.exit(7);\n",
    );

    try
    {
        const result = runProductRunner([
            "utility",
            builderRoot,
            sourceRoot,
            outputRoot,
            diagnosticsPath,
        ]);
        assert.equal(result.status, 2, result.stderr);
        const report = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
        assert.equal(report.status, 2);
        assert.equal(report.diagnostics[0].phase, "source-preflight");
        assert.equal(report.diagnostics[0].code, "UTILITY_ALIAS_CONTRACT_FAILED");
        assert.match(report.diagnostics[0].message, /fixture alias mismatch/);
        assert.equal(fs.existsSync(outputRoot), false);
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});

for (const fixture of [
    {
        entry: "component/button/index.js",
        expectedEntry: "component/button",
        expectedExtensions: [".js", ".scss"],
        expectedFilename: "button",
        lifecycle: runComponentBuild,
        product: "component",
    },
    {
        entry: "utility/space/default/index.scss",
        expectedEntry: "utility/space/default",
        expectedExtensions: [".scss", ".js"],
        expectedFilename: "default",
        lifecycle: runUtilityBuild,
        product: "utility",
    },
])
{
    test(`${fixture.product} lifecycle freezes raw/minified configurations`, async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `sf-${fixture.product}-lifecycle-`));
        const sourceRoot = path.join(workspace, "source");
        const outputRoot = path.join(workspace, "output");
        let configurations;

        writeFile(sourceRoot, fixture.entry, "/* fixture */\n");
        if (fixture.product === "utility")
        {
            writeFile(sourceRoot, "core/scss/fixture.scss", "// fixture\n");
        }

        try
        {
            const status = await fixture.lifecycle({ outputRoot, sourceRoot }, {
                adapters: ADAPTERS,
                webpack(receivedConfigurations)
                {
                    configurations = receivedConfigurations;
                    return {
                        close(callback) { callback(); },
                        run(callback)
                        {
                            callback(null, { hasErrors: () => false });
                        },
                    };
                },
            });

            assert.equal(status, 0);
            assert.deepEqual(
                configurations.map(configuration => {
                    const sassLoader = configuration.module.rules[1].use
                        .find(loader => loader === "sass-loader"
                            || (loader && loader.loader === "sass-loader"));

                    return {
                        entry: Object.keys(configuration.entry)[0],
                        filename: configuration.output.filename,
                        mode: configuration.mode,
                        resolveExtensions: configuration.resolve.extensions,
                        sassIncludePaths: typeof sassLoader === "string"
                            ? []
                            : sassLoader.options.sassOptions.includePaths
                                .map(includePath => path.basename(includePath)),
                    };
                }),
                [
                    {
                        entry: fixture.expectedEntry,
                        filename: `js/${fixture.expectedFilename}.js`,
                        mode: "development",
                        resolveExtensions: fixture.expectedExtensions,
                        sassIncludePaths: fixture.product === "utility"
                            ? ["scss", "core"]
                            : [],
                    },
                    {
                        entry: fixture.expectedEntry,
                        filename: `js/${fixture.expectedFilename}.min.js`,
                        mode: "production",
                        resolveExtensions: fixture.expectedExtensions,
                        sassIncludePaths: fixture.product === "utility"
                            ? ["scss", "core"]
                            : [],
                    },
                ],
            );
        }
        finally
        {
            fs.rmSync(workspace, { force: true, recursive: true });
        }
    });
}

test("Utility lifecycle rejects a pre-existing output root without webpack", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-utility-fresh-"));
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");
    const diagnostics = [];
    let webpackCalled = false;

    writeFile(sourceRoot, "utility/space/default/index.scss", ".fixture {}\n");
    fs.mkdirSync(outputRoot);

    try
    {
        const status = await runUtilityBuild({ outputRoot, sourceRoot }, {
            adapters: ADAPTERS,
            reportDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
            webpack()
            {
                webpackCalled = true;
                throw new Error("must not run");
            },
        });

        assert.equal(status, 2);
        assert.equal(webpackCalled, false);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].phase, "plan");
        assert.match(diagnostics[0].message, /outputRoot must not already exist/);
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});
