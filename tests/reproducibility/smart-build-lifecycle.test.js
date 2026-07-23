"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runSmartBuild } = require("../../libs/componentBuildLifecycle");

const PRODUCT_RUNNER = path.resolve(
    __dirname,
    "../../scripts/run-smart-product-build.cjs",
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

function invocationDiagnostic(result)
{
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE|\n\s+at\s/);

    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 1);

    return JSON.parse(lines[0]);
}

test("Smart product runner accepts exactly four absolute path arguments", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-smart-runner-"));
    const builderRoot = path.join(workspace, "builder");
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");
    const diagnosticsPath = path.join(workspace, "diagnostics.json");

    writeFile(builderRoot, "package.json", "{}\n");
    writeFile(
        builderRoot,
        "libs/componentBuildLifecycle.js",
        `exports.runSmartBuild = async (options, runtime) => {
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
            builderRoot,
            sourceRoot,
            outputRoot,
            diagnosticsPath,
        ]);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")), {
            diagnostics: [{
                options: { outputRoot, sourceRoot },
                phase: "fixture",
            }],
            status: 0,
        });
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});

test("Smart product runner rejects missing and extra arguments", () => {
    for (const argumentsList of [
        [],
        ["/a", "/b", "/c", "/d", "/e"],
    ])
    {
        const diagnostic = invocationDiagnostic(runProductRunner(argumentsList));

        assert.equal(diagnostic.code, "INVALID_ARGUMENT_COUNT");
        assert.equal(diagnostic.message, "expected exactly four path arguments");
        assert.equal(diagnostic.phase, "invocation");
        assert.equal(diagnostic.schemaVersion, 1);
        assert.equal(diagnostic.status, 2);
        assert.deepEqual(diagnostic.details, {
            actual: argumentsList.length,
            expected: 4,
        });
    }
});

test("Smart product runner rejects every non-absolute argument", () => {
    const diagnostic = invocationDiagnostic(runProductRunner([
        "builder",
        "/source",
        "output",
        "/diagnostics.json",
    ]));

    assert.equal(diagnostic.code, "ARGUMENT_NOT_ABSOLUTE");
    assert.equal(
        diagnostic.message,
        "all four arguments must be non-empty absolute paths",
    );
    assert.deepEqual(diagnostic.details, {
        invalidArguments: [
            { index: 0, name: "builderRoot" },
            { index: 2, name: "outputRoot" },
        ],
    });
    assert.equal(diagnostic.phase, "invocation");
    assert.equal(diagnostic.schemaVersion, 1);
    assert.equal(diagnostic.status, 2);
});

test("Smart product runner rejects a relative dependency runtime", () => {
    const result = runProductRunner([
        "/builder",
        "/source",
        "/output",
        "/diagnostics.json",
    ], {
        SF_SOURCE_DEPENDENCY_ROOT: "relative-runtime",
    });
    const diagnostic = invocationDiagnostic(result);

    assert.equal(diagnostic.code, "DEPENDENCY_ROOT_NOT_ABSOLUTE");
});

test("Smart runner resolves build dependencies from a disposable runtime", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-smart-runtime-"));
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
        `exports.runSmartBuild = async (options, runtime) => {
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
        const [configuration] = JSON.parse(
            fs.readFileSync(configurationPath, "utf8"),
        );
        assert.equal(configuration.optimization.chunkIds, false);
        assert.equal(configuration.optimization.moduleIds, false);
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

test("Smart lifecycle uses the frozen target and copies accepted templates", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-smart-lifecycle-"));
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");
    let configurations;

    writeFile(sourceRoot, "smart/modal/index.js", "export default 'modal';\n");
    writeFile(
        sourceRoot,
        "smart/modal/js/templates/default.js",
        "export default 'template';\n",
    );

    try
    {
        const status = await runSmartBuild({ outputRoot, sourceRoot }, {
            adapters: ADAPTERS,
            webpack(receivedConfigurations)
            {
                configurations = receivedConfigurations;

                return {
                    close(callback)
                    {
                        callback();
                    },
                    run(callback)
                    {
                        callback(null, { hasErrors: () => false });
                    },
                };
            },
        });

        assert.equal(status, 0);
        assert.equal(configurations.length, 2);
        assert.deepEqual(
            configurations.map(configuration => ({
                entry: Object.keys(configuration.entry)[0],
                filename: configuration.output.filename,
                mode: configuration.mode,
            })),
            [
                {
                    entry: "smart/modal",
                    filename: "js/modal.js",
                    mode: "production",
                },
                {
                    entry: "smart/modal",
                    filename: "js/modal.min.js",
                    mode: "production",
                },
            ],
        );
        assert.equal(
            fs.readFileSync(
                path.join(outputRoot, "smart/modal/template/default.js"),
                "utf8",
            ),
            "export default 'template';\n",
        );
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});

test("Smart lifecycle rejects a non-fresh output root", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-smart-fresh-"));
    const sourceRoot = path.join(workspace, "source");
    const outputRoot = path.join(workspace, "output");
    let webpackCalls = 0;

    writeFile(sourceRoot, "smart/modal/index.js", "export default 'modal';\n");
    fs.mkdirSync(outputRoot);

    try
    {
        const status = await runSmartBuild({ outputRoot, sourceRoot }, {
            adapters: ADAPTERS,
            webpack()
            {
                webpackCalls += 1;
            },
        });

        assert.equal(status, 2);
        assert.equal(webpackCalls, 0);
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});
