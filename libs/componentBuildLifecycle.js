"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
    createWebpackBuildDefinition,
} = require("./webpackConfigFactory");
const {
    materializeTemplates,
} = require("./templateMaterializer");
const {
    materializeGeneratedPackaging,
} = require("./generatedPackaging");
const {
    validateLegacyRuntimeCompatibility,
} = require("./legacyRuntimeCompatibility");
const {
    createPostcssPlugins,
} = require("./postcssPolicy");

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value))
    {
        return value;
    }

    for (const entry of Object.values(value))
    {
        deepFreeze(entry);
    }

    return Object.freeze(value);
}

const CORE_SASS_FALLBACK_ROOT = path.resolve(
    __dirname,
    "../resources/core",
);

const COMPONENT_TARGET = Object.freeze({
    directory: "component",
    entryPriority: Object.freeze(["index.js", "index.scss"]),
    name: "component",
    outputPrefix: "component",
    templateLayouts: Object.freeze([]),
});

const COMPONENT_TARGETS = Object.freeze([COMPONENT_TARGET]);
const UTILITY_TARGET = Object.freeze({
    directory: "utility",
    entryPriority: Object.freeze(["index.scss", "index.js"]),
    name: "utility",
    outputPrefix: "utility",
    templateLayouts: Object.freeze([]),
});
const UTILITY_TARGETS = Object.freeze([UTILITY_TARGET]);
const CORE_TARGET = Object.freeze({
    directory: "core",
    fixedEntries: Object.freeze([
        Object.freeze({ key: "core", file: "index.js", output: "core" }),
        Object.freeze({ key: "rule", file: "rule.js", output: "rule" }),
        Object.freeze({
            key: "utility.full",
            file: "utility-full.js",
            output: ".compat/utility-full",
        }),
    ]),
    name: "core",
    outputPrefix: "",
    templateLayouts: Object.freeze([]),
});
const CORE_TARGETS = Object.freeze([CORE_TARGET]);
const SMART_TARGET = Object.freeze({
    directory: "smart",
    entryPriority: Object.freeze(["index.scss", "index.js"]),
    name: "smart",
    outputPrefix: "smart",
    templateLayouts: Object.freeze(["template", "js/templates"]),
});
const SMART_TARGETS = Object.freeze([SMART_TARGET]);
const COMPONENT_SASS_RESOURCES = Object.freeze({
    component: Object.freeze([]),
});
const UTILITY_SASS_RESOURCES = Object.freeze({
    utility: Object.freeze([]),
});
const CORE_SASS_RESOURCES = Object.freeze({
    core: Object.freeze([]),
});
const SMART_SASS_RESOURCES = Object.freeze({
    smart: Object.freeze([]),
});
const COMPONENT_AUTOPREFIXER_OPTIONS = Object.freeze({
    backgroundColor: false,
    borderColor: false,
    color: false,
    position: true,
});
const COMPONENT_POSTCSS_PLUGIN_OPTIONS = Object.freeze({
    autoprefixer: COMPONENT_AUTOPREFIXER_OPTIONS,
    browsers: "last 1 version, >1%",
});
const COMPONENT_POSTCSS_PLUGINS = deepFreeze(createPostcssPlugins(
    COMPONENT_POSTCSS_PLUGIN_OPTIONS,
));
const COMPONENT_CONFIGURATION_POLICY = Object.freeze({
    devtool: false,
    output: Object.freeze({
        pathinfo: false,
    }),
    postcss: Object.freeze({
        plugins: COMPONENT_POSTCSS_PLUGINS,
    }),
    resolveExtensions: Object.freeze([".js", ".scss"]),
    target: "web",
});
const COMPONENT_CONFIGURATION_POLICIES = Object.freeze({
    component: COMPONENT_CONFIGURATION_POLICY,
});
const UTILITY_CONFIGURATION_POLICY = Object.freeze({
    ...COMPONENT_CONFIGURATION_POLICY,
    resolveExtensions: Object.freeze([".scss", ".js"]),
});
const UTILITY_CONFIGURATION_POLICIES = Object.freeze({
    utility: UTILITY_CONFIGURATION_POLICY,
});
const CORE_CONFIGURATION_POLICIES = Object.freeze({
    core: COMPONENT_CONFIGURATION_POLICY,
});
const SMART_CONFIGURATION_POLICIES = Object.freeze({
    smart: COMPONENT_CONFIGURATION_POLICY,
});

const COMPONENT_PROFILE = Object.freeze({
    configurationPoliciesByTarget: COMPONENT_CONFIGURATION_POLICIES,
    label: "component",
    sassResourcesByTarget: COMPONENT_SASS_RESOURCES,
    targets: COMPONENT_TARGETS,
});
const UTILITY_PROFILE = Object.freeze({
    configurationPoliciesByTarget: UTILITY_CONFIGURATION_POLICIES,
    label: "utility",
    sassResourcesByTarget: UTILITY_SASS_RESOURCES,
    targets: UTILITY_TARGETS,
});
const CORE_PROFILE = Object.freeze({
    configurationPoliciesByTarget: CORE_CONFIGURATION_POLICIES,
    label: "core",
    sassResourcesByTarget: CORE_SASS_RESOURCES,
    targets: CORE_TARGETS,
});
const SMART_PROFILE = Object.freeze({
    configurationPoliciesByTarget: SMART_CONFIGURATION_POLICIES,
    label: "smart",
    sassResourcesByTarget: SMART_SASS_RESOURCES,
    targets: SMART_TARGETS,
});

function messageFrom(value, fallback)
{
    try
    {
        if (typeof value === "string" && value.length > 0)
        {
            return value;
        }

        if (value
            && typeof value.message === "string"
            && value.message.length > 0)
        {
            return value.message;
        }

        if (value !== undefined && value !== null)
        {
            const rendered = String(value);

            if (rendered.length > 0)
            {
                return rendered;
            }
        }
    }
    catch
    {
        return fallback;
    }

    return fallback;
}

function reportDiagnostic(reporter, phase, value, fallback)
{
    if (typeof reporter !== "function")
    {
        return;
    }

    try
    {
        reporter({
            message: messageFrom(value, fallback),
            phase,
        });
    }
    catch
    {
        // Diagnostics are advisory and must not replace the lifecycle status.
    }
}

function readUsage(options, runtime)
{
    if (!options || typeof options !== "object" || Array.isArray(options))
    {
        throw new TypeError("options must be an object");
    }

    if (typeof options.sourceRoot !== "string"
        || options.sourceRoot.length === 0
        || !path.isAbsolute(options.sourceRoot))
    {
        throw new TypeError("sourceRoot must be a non-empty absolute path");
    }

    if (typeof options.outputRoot !== "string"
        || options.outputRoot.length === 0
        || !path.isAbsolute(options.outputRoot))
    {
        throw new TypeError("outputRoot must be a non-empty absolute path");
    }

    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime))
    {
        throw new TypeError("runtime must be an object");
    }

    const webpack = runtime.webpack;
    const adapters = runtime.adapters;
    const reporter = runtime.reportDiagnostic;

    if (typeof webpack !== "function")
    {
        throw new TypeError("runtime.webpack must be a function");
    }

    if (!adapters || typeof adapters !== "object" || Array.isArray(adapters))
    {
        throw new TypeError("runtime.adapters must be an object");
    }

    if (reporter !== undefined && typeof reporter !== "function")
    {
        throw new TypeError("runtime.reportDiagnostic must be a function");
    }

    return {
        adapters,
        entryKeys: options.entryKeys === undefined
            ? null
            : validateEntryKeys(options.entryKeys),
        legacyCompatibility: validateLegacyRuntimeCompatibility(options.legacyCompatibility),
        outputRoot: options.outputRoot,
        reporter,
        sourceRoot: options.sourceRoot,
        webpack,
    };
}

function validateEntryKeys(value)
{
    if (!Array.isArray(value)
        || value.length === 0
        || value.some(entry => typeof entry !== "string"
            || !entry.startsWith("utility/")
            || entry.endsWith("/")
            || entry.includes("\\")
            || entry.split("/").some(segment =>
                segment.length === 0 || segment === "." || segment === ".."))
        || new Set(value).size !== value.length)
    {
        throw new TypeError(
            "entryKeys must be a non-empty unique array of portable utility/* keys",
        );
    }

    return [...value].sort();
}

function applyUtilityEntryFilter(definition, entryKeys)
{
    if (!entryKeys)
    {
        return;
    }

    const requested = new Set(entryKeys);
    const available = new Set(definition.plan.entries.map(entry => entry.key));
    const missing = entryKeys.filter(entry => !available.has(entry));

    if (missing.length > 0)
    {
        throw new Error(`entryKeys contain unknown entries: ${missing.join(", ")}`);
    }

    definition.plan.entries = definition.plan.entries.filter(entry =>
        requested.has(entry.key));
    definition.configurations = definition.configurations.filter(configuration =>
        Object.keys(configuration.entry).some(entry => requested.has(entry)));
    definition.plan.templates = definition.plan.templates.filter(template =>
        requested.has(`utility/${template.component}`));
    definition.templateCopies = definition.plan.templates;
}

function usageReporter(runtime)
{
    try
    {
        return runtime && typeof runtime.reportDiagnostic === "function"
            ? runtime.reportDiagnostic
            : undefined;
    }
    catch
    {
        return undefined;
    }
}

function assertFreshOutputRoot(outputRoot)
{
    try
    {
        fs.lstatSync(outputRoot);
    }
    catch (error)
    {
        if (error && error.code === "ENOENT")
        {
            return;
        }

        throw error;
    }

    throw new Error(`outputRoot must not already exist: ${outputRoot}`);
}

function isWithin(root, candidate)
{
    const relative = path.relative(root, candidate);

    return relative === ""
        || (!relative.startsWith(`..${path.sep}`)
            && relative !== ".."
            && !path.isAbsolute(relative));
}

function canonicalDirectoryWithin(root, candidate, label)
{
    const canonicalRoot = fs.realpathSync(root);
    const canonicalCandidate = fs.realpathSync(candidate);

    if (!fs.statSync(canonicalCandidate).isDirectory()
        || !isWithin(canonicalRoot, canonicalCandidate))
    {
        throw new Error(`${label} must be a directory inside its declared root`);
    }

    return canonicalCandidate;
}

function coreSassIncludePaths(sourceRoot)
{
    const sourceSassRoot = canonicalDirectoryWithin(
        sourceRoot,
        path.join(sourceRoot, "core/scss"),
        "Core Sass source root",
    );
    const builderRoot = path.resolve(__dirname, "..");
    const fallbackRoot = canonicalDirectoryWithin(
        builderRoot,
        CORE_SASS_FALLBACK_ROOT,
        "Core Sass fallback root",
    );
    const fallbackModule = path.join(
        fallbackRoot,
        "_sf_css__theme_custom.scss",
    );

    if (!fs.statSync(fallbackModule).isFile())
    {
        throw new Error("Core Sass fallback module must be a regular file");
    }

    return [sourceSassRoot, fallbackRoot];
}

function applyCoreSassPolicy(configurations, sourceRoot)
{
    const includePaths = coreSassIncludePaths(sourceRoot);

    for (const configuration of configurations)
    {
        const styleRule = configuration.module.rules.find(rule =>
            rule && String(rule.test) === String(/\.(scss|css)$/));
        const sassLoaderIndex = styleRule.use.indexOf("sass-loader");

        if (sassLoaderIndex === -1)
        {
            throw new Error("Core Sass loader is missing from configuration");
        }

        styleRule.use[sassLoaderIndex] = {
            loader: "sass-loader",
            options: {
                sassOptions: {
                    includePaths: [...includePaths],
                },
            },
        };
    }
}

function closeCompiler(compiler, close, reporter, priorFailure)
{
    return new Promise(resolve => {
        let callbackError;
        let callbackSeen = false;
        let invocationComplete = false;
        let settled = false;

        function finish()
        {
            if (settled || !invocationComplete || !callbackSeen)
            {
                return;
            }

            settled = true;

            if (callbackError)
            {
                reportDiagnostic(
                    reporter,
                    "close",
                    callbackError,
                    "compiler close failed",
                );
                resolve(1);

                return;
            }

            resolve(priorFailure ? 1 : 0);
        }

        function onClose(error)
        {
            if (callbackSeen || settled)
            {
                return;
            }

            callbackSeen = true;
            callbackError = error;
            finish();
        }

        try
        {
            close.call(compiler, onClose);
            invocationComplete = true;
            finish();
        }
        catch (error)
        {
            invocationComplete = true;

            if (!settled)
            {
                settled = true;
                reportDiagnostic(
                    reporter,
                    "close",
                    error,
                    "compiler close threw",
                );
                resolve(1);
            }
        }
    });
}

function inspectStats(error, stats)
{
    if (error)
    {
        return {
            message: messageFrom(error, "compiler run failed"),
            phase: "run",
        };
    }

    if (!stats
        || (typeof stats !== "object" && typeof stats !== "function"))
    {
        return {
            message: "compiler returned missing or invalid stats",
            phase: "stats",
        };
    }

    try
    {
        if (typeof stats.hasErrors !== "function")
        {
            return {
                message: "compiler stats.hasErrors must be a function",
                phase: "stats",
            };
        }

        if (stats.hasErrors())
        {
            return {
                message: "compiler stats reported errors",
                phase: "stats",
            };
        }
    }
    catch (statsError)
    {
        return {
            message: messageFrom(statsError, "compiler stats inspection failed"),
            phase: "stats",
        };
    }

    return null;
}

function runCompiler(compiler, run, close, reporter)
{
    return new Promise(resolve => {
        let callbackError;
        let callbackSeen = false;
        let callbackStats;
        let invocationComplete = false;
        let terminal = false;

        function closeAfter(failure)
        {
            closeCompiler(
                compiler,
                close,
                reporter,
                Boolean(failure),
            ).then(resolve);
        }

        function finish()
        {
            if (terminal || !invocationComplete || !callbackSeen)
            {
                return;
            }

            terminal = true;
            const failure = inspectStats(callbackError, callbackStats);

            if (failure)
            {
                reportDiagnostic(
                    reporter,
                    failure.phase,
                    failure.message,
                    failure.message,
                );
            }

            closeAfter(failure);
        }

        function onRun(error, stats)
        {
            if (callbackSeen || terminal)
            {
                return;
            }

            callbackSeen = true;
            callbackError = error;
            callbackStats = stats;
            finish();
        }

        try
        {
            run.call(compiler, onRun);
            invocationComplete = true;
            finish();
        }
        catch (error)
        {
            invocationComplete = true;

            if (!terminal)
            {
                terminal = true;
                reportDiagnostic(
                    reporter,
                    "run",
                    error,
                    "compiler run threw",
                );
                closeAfter(true);
            }
        }
    });
}

async function runBuild(options, runtime, profile)
{
    let usage;

    try
    {
        usage = readUsage(options, runtime);
    }
    catch (error)
    {
        reportDiagnostic(
            usageReporter(runtime),
            "usage",
            error,
            "invalid lifecycle usage",
        );

        return 2;
    }

    let definition;

    try
    {
        assertFreshOutputRoot(usage.outputRoot);
        definition = createWebpackBuildDefinition({
            configurationPoliciesByTarget:
                profile.configurationPoliciesByTarget,
            outputRoot: usage.outputRoot,
            sassResourcesByTarget: profile.sassResourcesByTarget,
            sourceRoot: usage.sourceRoot,
            targets: profile.targets,
        }, usage.adapters);
        definition.plan.legacyCompatibility = usage.legacyCompatibility;

        if (usage.entryKeys && profile !== UTILITY_PROFILE)
        {
            throw new Error("entryKeys are supported only by the utility lifecycle");
        }

        if (profile === UTILITY_PROFILE)
        {
            applyUtilityEntryFilter(definition, usage.entryKeys);
        }

        if (profile === CORE_PROFILE || profile === UTILITY_PROFILE)
        {
            applyCoreSassPolicy(
                definition.configurations,
                usage.sourceRoot,
            );
        }
    }
    catch (error)
    {
        reportDiagnostic(
            usage.reporter,
            "plan",
            error,
            `${profile.label} build planning failed`,
        );

        return 2;
    }

    let compiler;

    try
    {
        compiler = usage.webpack(definition.configurations);
    }
    catch (error)
    {
        reportDiagnostic(
            usage.reporter,
            "webpack",
            error,
            "webpack construction failed",
        );

        return 1;
    }

    if (!compiler
        || (typeof compiler !== "object" && typeof compiler !== "function"))
    {
        reportDiagnostic(
            usage.reporter,
            "webpack",
            "webpack did not return a compiler",
            "webpack did not return a compiler",
        );

        return 1;
    }

    let close;

    try
    {
        close = compiler.close;
    }
    catch (error)
    {
        reportDiagnostic(
            usage.reporter,
            "close",
            error,
            "compiler close is unavailable",
        );

        return 1;
    }

    if (typeof close !== "function")
    {
        reportDiagnostic(
            usage.reporter,
            "close",
            "compiler.close must be a function",
            "compiler.close must be a function",
        );

        return 1;
    }

    let run;

    try
    {
        run = compiler.run;
    }
    catch (error)
    {
        reportDiagnostic(
            usage.reporter,
            "run",
            error,
            "compiler run is unavailable",
        );

        return closeCompiler(
            compiler,
            close,
            usage.reporter,
            true,
        );
    }

    if (typeof run !== "function")
    {
        reportDiagnostic(
            usage.reporter,
            "run",
            "compiler.run must be a function",
            "compiler.run must be a function",
        );

        return closeCompiler(
            compiler,
            close,
            usage.reporter,
            true,
        );
    }

    const status = await runCompiler(
        compiler,
        run,
        close,
        usage.reporter,
    );

    if (status !== 0)
    {
        return status;
    }

    try
    {
        materializeTemplates(definition.templateCopies);
        materializeGeneratedPackaging(definition.plan);
    }
    catch (error)
    {
        reportDiagnostic(
            usage.reporter,
            "packaging",
            error,
            `${profile.label} generated packaging failed`,
        );

        return 1;
    }

    return 0;
}

function runComponentBuild(options, runtime)
{
    return runBuild(options, runtime, COMPONENT_PROFILE);
}

function runUtilityBuild(options, runtime)
{
    return runBuild(options, runtime, UTILITY_PROFILE);
}

function runCoreBuild(options, runtime)
{
    return runBuild(options, runtime, CORE_PROFILE);
}

function runSmartBuild(options, runtime)
{
    return runBuild(options, runtime, SMART_PROFILE);
}

module.exports = {
    runComponentBuild,
    runCoreBuild,
    runSmartBuild,
    runUtilityBuild,
};
