"use strict";

// Product component package runner (docs/developer/product-packages.md). The
// same contract as the other product runners (docs/developer/product-runners.md:
// four absolute paths, a fresh output root, a diagnostics JSON), plus the
// package: `--package <name> --components <folder>[,<folder>...]`. sourceRoot is
// the `src` of a package overlay (libs/packageProduct.js
// materializePackageOverlay). Output: <out>/smart/<folder> for each component
// and <out>/smart/rule.js, which registers the package `<name>`.
//
// usage: run-package-product-build.cjs --package <name> --components <list> [--api <rule>]
//            [--core <folder>:<abi>]
//            <builderRoot> <sourceRoot> <outputRoot> <diagnosticsPath>
//
// --api names the rule whose bundle gives a component set's exports
// (standard simai.component-set; the package folder's package.json simai.api):
// the rule file then registers it as `api`.
//
// --core names the package's shared core (package.json simai.core,
// libs/packageCore.js): the helper folder built once as smart/<folder>, whose
// modules the components take from the page's runtime as
// SF.runtimeModule("<name>/<module>", <abi>). What the components asked of it
// is written beside the diagnostics (<diagnostics>.core.json).

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const {
    configureProductConfigurations,
} = require("../libs/productWebpackRuntime");
const { applySharedRuntimeExternals, runtimeUsageReport } = require("../libs/sharedRuntime");
const { applyComponentManifestEmbed } = require("../libs/componentManifestEmbed");
const { compatibilityFromEnvironment } = require("../libs/legacyRuntimeCompatibility");
const { coreRuleName, parseCoreOption } = require("../libs/packageCore");

const ARGUMENT_NAMES = Object.freeze([
    "builderRoot",
    "sourceRoot",
    "outputRoot",
    "diagnosticsPath",
]);
const OPTION_NAMES = Object.freeze(["--package", "--components", "--api", "--core"]);

function splitOptions(received)
{
    const options = {};
    const positional = [];

    for (let index = 0; index < received.length; index += 1)
    {
        if (OPTION_NAMES.includes(received[index]))
        {
            options[received[index].slice(2)] = received[index + 1];
            index += 1;
        }
        else
        {
            positional.push(received[index]);
        }
    }

    return { options, positional };
}

const { options: packageOptions, positional: argumentsReceived } = splitOptions(process.argv.slice(2));

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

let usage = validatedArguments(argumentsReceived);

if (usage && (typeof packageOptions.package !== "string" || typeof packageOptions.components !== "string"))
{
    reportInvocationFailure(
        "PACKAGE_REQUIRED",
        "--package <name> and --components <folder>[,<folder>...] are required",
        { received: Object.keys(packageOptions) },
    );
    usage = null;
}

let core = null;

if (usage && packageOptions.core !== undefined)
{
    try
    {
        core = parseCoreOption(packageOptions.core);
    }
    catch (error)
    {
        reportInvocationFailure("INVALID_CORE", error.message, { received: packageOptions.core });
        usage = null;
    }
}

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
    const { runPackageBuild } = require(path.join(
        builderRoot,
        "libs/componentBuildLifecycle.js",
    ));
    const webpackImplementation = builderRequire("webpack");

    // The shared runtime modules and names the bundles ask for: written beside
    // the diagnostics (<diagnostics>.runtime.json) for the package receipt.
    const runtimeUsage = {};
    // The package core: the folders whose bundles take it, and the names they
    // ask of each of its modules.
    const packageCore = core
        ? { ...core, moduleUsers: {}, name: packageOptions.package, usage: {}, users: new Set() }
        : null;

    function webpack(configurations)
    {
        configureProductConfigurations(configurations, {
            builderDependencyRoot: dependencyRoot,
            builderRoot,
            sourceDependencyRoot,
            sourceRoot,
        });
        // Smart elements take lit and smart-base from the shared runtime Core
        // loads once per page, instead of a copy each.
        applySharedRuntimeExternals(configurations, { sourceRoot, usage: runtimeUsage, packageCore });
        // Each element embeds only the keys of its component.json the runtime reads.
        applyComponentManifestEmbed(configurations, { sourceRoot });
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
                    if (process.env.SF_BUILD_MODULE_STATS)
                    {
                        // Diagnostic only: which modules each bundle carries.
                        fs.writeFileSync(`${diagnosticsPath}.modules.json`, JSON.stringify(stats.toJson({
                            all: false, children: true, chunks: true, chunkModules: true, nestedModules: true,
                            ids: true, entrypoints: true, assets: true, chunkRelations: false,
                        })));
                    }
                    fs.writeFileSync(
                        `${diagnosticsPath}.runtime.json`,
                        `${JSON.stringify(runtimeUsageReport(runtimeUsage, sourceRoot), null, 2)}\n`,
                    );
                    if (packageCore)
                    {
                        fs.writeFileSync(`${diagnosticsPath}.core.json`, `${JSON.stringify({
                            schema: "simai.framework.package-core-usage",
                            version: 1,
                            folder: packageCore.folder,
                            rule: coreRuleName(packageCore),
                            abi: packageCore.abi,
                            id_prefix: `${packageCore.name}/`,
                            users: [...packageCore.users].sort(),
                            modules: Object.fromEntries(Object.keys(packageCore.usage).sort()
                                .map((id) => [id, [...packageCore.usage[id]].sort()])),
                            // The components that import each module directly
                            // (a module imported only by other core modules has none).
                            module_users: Object.fromEntries(Object.keys(packageCore.moduleUsers).sort()
                                .map((id) => [id, [...packageCore.moduleUsers[id]].sort()])),
                        }, null, 2)}\n`);
                    }
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
        ...(packageCore ? { packageCoreUsers: packageCore.users } : {}),
        webpack,
    };

    const buildOptions = {
        outputRoot,
        package: {
            ...(packageOptions.api ? { api: packageOptions.api } : {}),
            components: packageOptions.components.split(","),
            ...(core ? { core } : {}),
            name: packageOptions.package,
        },
        sourceRoot,
    };
    const legacyCompatibility = compatibilityFromEnvironment();
    if (legacyCompatibility) buildOptions.legacyCompatibility = legacyCompatibility;

    runPackageBuild(buildOptions, runtime).then(status => {
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
