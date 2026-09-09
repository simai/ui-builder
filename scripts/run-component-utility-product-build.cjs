"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

const {
    configureProductConfigurations,
} = require("../libs/productWebpackRuntime");
const { compatibilityFromEnvironment } = require("../libs/legacyRuntimeCompatibility");

const ARGUMENT_NAMES = Object.freeze([
    "product",
    "builderRoot",
    "sourceRoot",
    "outputRoot",
    "diagnosticsPath",
]);
const PRODUCTS = Object.freeze({
    component: "runComponentBuild",
    utility: "runUtilityBuild",
});

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
            "expected a product and exactly four path arguments",
            { actual: received.length, expected: ARGUMENT_NAMES.length },
        );
        return null;
    }

    const [product, ...paths] = received;

    if (!Object.prototype.hasOwnProperty.call(PRODUCTS, product))
    {
        reportInvocationFailure(
            "INVALID_PRODUCT",
            "product must be component or utility",
            { product },
        );
        return null;
    }

    const invalidArguments = paths
        .map((candidate, index) => ({
            candidate,
            index: index + 1,
            name: ARGUMENT_NAMES[index + 1],
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
            "all four path arguments must be non-empty absolute paths",
            { invalidArguments },
        );
        return null;
    }

    return Object.fromEntries(
        ARGUMENT_NAMES.map((name, index) => [name, received[index]]),
    );
}

function entryKeysFromEnvironment(product)
{
    const manifestPath = process.env.SF_PRODUCT_ENTRY_FILTER_MANIFEST;

    if (!manifestPath)
    {
        return null;
    }

    if (product !== "utility" || !path.isAbsolute(manifestPath))
    {
        throw new Error(
            "SF_PRODUCT_ENTRY_FILTER_MANIFEST requires utility and an absolute path",
        );
    }

    const stat = fs.lstatSync(manifestPath);

    if (stat.isSymbolicLink() || !stat.isFile())
    {
        throw new Error("entry filter manifest must be a regular file");
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    if (!manifest
        || Object.keys(manifest).sort().join(",") !== "entryKeys,schemaVersion,target"
        || manifest.schemaVersion !== 1
        || manifest.target !== "utility"
        || !Array.isArray(manifest.entryKeys))
    {
        throw new Error("entry filter manifest is invalid");
    }

    return manifest.entryKeys;
}

function runUtilitySourcePreflight(product, sourceRoot, dependencyRoot)
{
    if (product !== "utility") return null;

    const contractPath = path.join(
        sourceRoot,
        "core/contracts/utility-module-aliases.v1.json",
    );
    if (!fs.existsSync(contractPath)) return null;

    const verifierPath = path.resolve(
        sourceRoot,
        "../scripts/verify-utility-module-aliases.mjs",
    );
    let stat;
    try
    {
        stat = fs.lstatSync(verifierPath);
    }
    catch (error)
    {
        return {
            code: "UTILITY_ALIAS_VERIFIER_MISSING",
            message: error && error.message ? error.message : String(error),
        };
    }
    if (stat.isSymbolicLink() || !stat.isFile())
    {
        return {
            code: "UTILITY_ALIAS_VERIFIER_INVALID",
            message: "utility alias verifier must be a regular source file",
        };
    }

    const result = spawnSync(process.execPath, [verifierPath, dependencyRoot], {
        cwd: path.resolve(sourceRoot, ".."),
        encoding: "utf8",
        env: process.env,
    });
    if (result.status === 0) return null;

    return {
        code: "UTILITY_ALIAS_CONTRACT_FAILED",
        message: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
    };
}

const usage = validatedArguments(process.argv.slice(2));

if (usage)
{
    const {
        builderRoot,
        diagnosticsPath,
        outputRoot,
        product,
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
    const lifecycle = require(path.join(
        builderRoot,
        "libs/componentBuildLifecycle.js",
    ));
    const runBuild = lifecycle[PRODUCTS[product]];
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
    const sourcePreflightFailure = runUtilitySourcePreflight(
        product,
        sourceRoot,
        dependencyRoot,
    );
    if (sourcePreflightFailure)
    {
        diagnostics.push({
            ...sourcePreflightFailure,
            phase: "source-preflight",
        });
        fs.writeFileSync(
            diagnosticsPath,
            `${JSON.stringify({ diagnostics, product, status: 2 }, null, 2)}\n`,
        );
        process.exitCode = 2;
        return;
    }
    try
    {
        const entryKeys = entryKeysFromEnvironment(product);
        if (entryKeys) buildOptions.entryKeys = entryKeys;
    }
    catch (error)
    {
        reportInvocationFailure(
            "INVALID_ENTRY_FILTER_MANIFEST",
            error && error.message ? error.message : String(error),
            {},
        );
        return;
    }
    const legacyCompatibility = compatibilityFromEnvironment();
    if (legacyCompatibility) buildOptions.legacyCompatibility = legacyCompatibility;

    runBuild(buildOptions, runtime).then(status => {
        fs.writeFileSync(
            diagnosticsPath,
            `${JSON.stringify({ diagnostics, product, status }, null, 2)}\n`,
        );
        process.exitCode = status;
    }, error => {
        fs.writeFileSync(diagnosticsPath, `${JSON.stringify({
            diagnostics,
            fatal: error && error.stack ? error.stack : String(error),
            product,
            status: 1,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}
