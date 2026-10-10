"use strict";

// SIMAI Framework Pro product runner. The same contract as the other product
// runners (docs/developer/product-runners.md: four absolute paths, a fresh
// output root, a diagnostics JSON); sourceRoot is the `src` of a Pro overlay
// (libs/proProduct.js materializeProOverlay). Output: <out>/smart/<pro folder>
// and <out>/smart/rule.js.

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const {
    configureProductConfigurations,
} = require("../libs/productWebpackRuntime");
const { compatibilityFromEnvironment } = require("../libs/legacyRuntimeCompatibility");

const ARGUMENT_NAMES = Object.freeze([
    "builderRoot",
    "sourceRoot",
    "outputRoot",
    "diagnosticsPath",
]);
const argumentsReceived = process.argv.slice(2);

function reportInvocationFailure(code, message, details)
{
    process.stderr.write(`${JSON.stringify({
        code,
        details,
        message,
        phase: "invocation",
        schemaVersion: 1,
        status: 2,
    })}\n`);
    process.exitCode = 2;
}

function validatedArguments(received)
{
    if (received.length !== ARGUMENT_NAMES.length)
    {
        reportInvocationFailure(
            "INVALID_ARGUMENT_COUNT",
            "expected exactly four path arguments",
            {
                actual: received.length,
                expected: ARGUMENT_NAMES.length,
            },
        );

        return null;
    }

    const invalidArguments = received
        .map((candidate, index) => ({
            candidate,
            index,
            name: ARGUMENT_NAMES[index],
        }))
        .filter(({ candidate }) =>
            typeof candidate !== "string"
            || candidate.length === 0
            || !path.isAbsolute(candidate))
        .map(({ index, name }) => ({ index, name }));

    if (invalidArguments.length > 0)
    {
        reportInvocationFailure(
            "ARGUMENT_NOT_ABSOLUTE",
            "all four arguments must be non-empty absolute paths",
            { invalidArguments },
        );

        return null;
    }

    return Object.fromEntries(
        ARGUMENT_NAMES.map((name, index) => [name, received[index]]),
    );
}

const usage = validatedArguments(argumentsReceived);

if (usage)
{
    const {
        builderRoot,
        diagnosticsPath,
        outputRoot,
        sourceRoot,
    } = usage;

    const dependencyRoot = process.env.SF_BUILDER_DEPENDENCY_ROOT || builderRoot;
    const sourceDependencyRoot = process.env.SF_SOURCE_DEPENDENCY_ROOT
        || sourceRoot;

    if (!path.isAbsolute(dependencyRoot)
        || !path.isAbsolute(sourceDependencyRoot))
    {
        reportInvocationFailure(
            "DEPENDENCY_ROOT_NOT_ABSOLUTE",
            "dependency runtime roots must be absolute paths",
            { dependencyRoot, sourceDependencyRoot },
        );
        return;
    }

    process.chdir(builderRoot);

    const builderRequire = createRequire(path.join(
        dependencyRoot,
        "package.json",
    ));
    const { runProBuild } = require(path.join(
        builderRoot,
        "libs/componentBuildLifecycle.js",
    ));
    const webpackImplementation = builderRequire("webpack");

    function webpack(configurations)
    {
        configureProductConfigurations(configurations, {
            builderDependencyRoot: dependencyRoot,
            builderRoot,
            sourceDependencyRoot,
            sourceRoot,
        });
        const compiler = webpackImplementation(configurations);
        const run = compiler.run;

        compiler.run = function runWithEvidence(callback)
        {
            return run.call(this, (error, stats) => {
                if (stats && typeof stats.toJson === "function")
                {
                    const details = stats.toJson({
                        all: false,
                        errors: true,
                        errorsCount: true,
                        warnings: true,
                        warningsCount: true,
                    });
                    fs.writeFileSync(
                        `${diagnosticsPath}.stats.json`,
                        `${JSON.stringify(details, null, 2)}\n`,
                    );
                }

                callback(error, stats);
            });
        };

        return compiler;
    }

    const diagnostics = [];
    const runtime = {
        adapters: {
            MiniCssExtractPlugin: builderRequire("mini-css-extract-plugin"),
            RemoveEmptyScriptsPlugin: builderRequire(
                "webpack-remove-empty-scripts",
            ),
            TerserPlugin: builderRequire("terser-webpack-plugin"),
        },
        reportDiagnostic(diagnostic)
        {
            diagnostics.push(diagnostic);
        },
        webpack,
    };

    const buildOptions = { sourceRoot, outputRoot };
    const legacyCompatibility = compatibilityFromEnvironment();
    if (legacyCompatibility) buildOptions.legacyCompatibility = legacyCompatibility;

    runProBuild(buildOptions, runtime).then(status => {
        fs.writeFileSync(
            diagnosticsPath,
            `${JSON.stringify({ diagnostics, status }, null, 2)}\n`,
        );
        process.exitCode = status;
    }, error => {
        fs.writeFileSync(diagnosticsPath, `${JSON.stringify({
            diagnostics,
            fatal: error && error.stack ? error.stack : String(error),
            status: 1,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}
