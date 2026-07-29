"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const LIFECYCLE_PATH = require.resolve(
    "../../libs/componentBuildLifecycle",
);
const FACTORY_PATH = require.resolve("../../libs/webpackConfigFactory");
const PLAN_PATH = require.resolve("../../libs/buildPlan");
const {
    createPostcssPlugins,
} = require("../../libs/postcssPolicy");

const {
    runComponentBuild,
    runUtilityBuild,
} = require(LIFECYCLE_PATH);
const {
    createWebpackBuildDefinition,
} = require(FACTORY_PATH);

class MiniCssExtractPluginStub
{
    static loader = "mini-css-extract-loader-stub";

    constructor(options)
    {
        this.adapter = "mini-css-extract";
        this.options = options;
    }
}

class RemoveEmptyScriptsPluginStub
{
    constructor()
    {
        this.adapter = "remove-empty-scripts";
    }
}

class TerserPluginStub
{
    constructor(options)
    {
        this.adapter = "terser";
        this.options = options;
    }
}

const ADAPTERS = Object.freeze({
    MiniCssExtractPlugin: MiniCssExtractPluginStub,
    RemoveEmptyScriptsPlugin: RemoveEmptyScriptsPluginStub,
    TerserPlugin: TerserPluginStub,
});

function componentConfigurationPolicy()
{
    return {
        devtool: false,
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
        output: {
            pathinfo: false,
        },
    };
}

function makeWorkspace(prefix = "sf-component-lifecycle-")
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    return {
        outputRoot: path.join(workspace, "output"),
        sourceRoot: path.join(workspace, "source"),
        workspace,
    };
}

function removeWorkspace(workspace)
{
    fs.rmSync(workspace, { force: true, recursive: true });
}

function writeFile(root, relativePath, content)
{
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
}

function writeComponentFixture(sourceRoot, entryCount = 1, scssCount = 0)
{
    const firstScssIndex = entryCount - scssCount;

    for (let index = 0; index < entryCount; index += 1)
    {
        const name = `entry-${String(index).padStart(3, "0")}`;
        const extension = index >= firstScssIndex ? "scss" : "js";
        const content = extension === "scss"
            ? `.${name} {}\n`
            : `module.exports = ${JSON.stringify(name)};\n`;

        writeFile(
            sourceRoot,
            path.join("component", name, `index.${extension}`),
            content,
        );
    }
}

function snapshotTree(root)
{
    const snapshot = [];

    function visit(directory, relativeDirectory)
    {
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => {
                if (left.name < right.name)
                {
                    return -1;
                }

                if (left.name > right.name)
                {
                    return 1;
                }

                return 0;
            });

        for (const entry of entries)
        {
            const absolutePath = path.join(directory, entry.name);
            const relativePath = relativeDirectory === ""
                ? entry.name
                : path.join(relativeDirectory, entry.name);

            if (entry.isDirectory())
            {
                snapshot.push(`directory:${relativePath}`);
                visit(absolutePath, relativePath);
            }
            else if (entry.isSymbolicLink())
            {
                snapshot.push(
                    `symlink:${relativePath}:${fs.readlinkSync(absolutePath)}`,
                );
            }
            else
            {
                const digest = crypto.createHash("sha256")
                    .update(fs.readFileSync(absolutePath))
                    .digest("hex");
                snapshot.push(`file:${relativePath}:${digest}`);
            }
        }
    }

    visit(root, "");

    return snapshot;
}

function successfulStats()
{
    return {
        hasErrors()
        {
            return false;
        },
    };
}

function successfulCompiler(counts)
{
    return {
        close(callback)
        {
            counts.close += 1;
            callback();
        },
        run(callback)
        {
            counts.run += 1;
            callback(null, successfulStats());
        },
    };
}

function validRuntime(webpack, reportDiagnostic)
{
    return {
        adapters: ADAPTERS,
        reportDiagnostic,
        webpack,
    };
}

function styleRule(configuration)
{
    return configuration.module.rules.find(rule =>
        rule.test instanceof RegExp && rule.test.test(".scss"));
}

function postcssLoader(configuration)
{
    return styleRule(configuration).use.find(loader =>
        loader
        && typeof loader === "object"
        && loader.loader === "postcss-loader");
}

function loadLifecycleWithFactory(factory)
{
    const lifecycleCache = require.cache[LIFECYCLE_PATH];
    const factoryCache = require.cache[FACTORY_PATH];
    const originalFactoryExports = factoryCache.exports;

    factoryCache.exports = {
        createWebpackBuildDefinition: factory,
    };
    delete require.cache[LIFECYCLE_PATH];

    try
    {
        return require(LIFECYCLE_PATH);
    }
    finally
    {
        delete require.cache[LIFECYCLE_PATH];
        factoryCache.exports = originalFactoryExports;

        if (lifecycleCache)
        {
            require.cache[LIFECYCLE_PATH] = lifecycleCache;
        }
    }
}

test("module evaluation resolves only built-ins and relative local modules", () => {
    const workspace = makeWorkspace("sf-component-import-");
    writeComponentFixture(workspace.sourceRoot);
    const sourceBefore = snapshotTree(workspace.sourceRoot);
    const originalEnv = process.env;
    const originalResolveFilename = Module._resolveFilename;
    const cachedLifecycle = require.cache[LIFECYCLE_PATH];
    const cachedFactory = require.cache[FACTORY_PATH];
    const cachedPlan = require.cache[PLAN_PATH];
    const resolvedRequests = [];
    const originalMethods = {
        appendFileSync: fs.appendFileSync,
        copyFileSync: fs.copyFileSync,
        createWriteStream: fs.createWriteStream,
        mkdirSync: fs.mkdirSync,
        renameSync: fs.renameSync,
        rmSync: fs.rmSync,
        unlinkSync: fs.unlinkSync,
        writeFileSync: fs.writeFileSync,
        error: console.error,
        log: console.log,
        warn: console.warn,
    };

    try
    {
        delete require.cache[LIFECYCLE_PATH];
        delete require.cache[FACTORY_PATH];
        delete require.cache[PLAN_PATH];

        Module._resolveFilename = function guardedResolve(request, ...args)
        {
            resolvedRequests.push(request);

            if (!request.startsWith("node:")
                && !request.startsWith(".")
                && !path.isAbsolute(request))
            {
                throw new Error(`external package resolution: ${request}`);
            }

            return originalResolveFilename.call(this, request, ...args);
        };
        process.env = new Proxy(originalEnv, {
            get(target, property)
            {
                throw new Error(`process.env read: ${String(property)}`);
            },
        });

        const forbidden = operation => () => {
            throw new Error(`forbidden operation: ${operation}`);
        };
        fs.appendFileSync = forbidden("appendFileSync");
        fs.copyFileSync = forbidden("copyFileSync");
        fs.createWriteStream = forbidden("createWriteStream");
        fs.mkdirSync = forbidden("mkdirSync");
        fs.renameSync = forbidden("renameSync");
        fs.rmSync = forbidden("rmSync");
        fs.unlinkSync = forbidden("unlinkSync");
        fs.writeFileSync = forbidden("writeFileSync");
        console.error = forbidden("console.error");
        console.log = forbidden("console.log");
        console.warn = forbidden("console.warn");

        const imported = require(LIFECYCLE_PATH);

        assert.equal(typeof imported.runComponentBuild, "function");
        assert.ok(resolvedRequests.length > 0);
        assert.ok(resolvedRequests.every(request =>
            request.startsWith("node:")
            || request.startsWith(".")
            || path.isAbsolute(request)));
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        Module._resolveFilename = originalResolveFilename;
        process.env = originalEnv;
        fs.appendFileSync = originalMethods.appendFileSync;
        fs.copyFileSync = originalMethods.copyFileSync;
        fs.createWriteStream = originalMethods.createWriteStream;
        fs.mkdirSync = originalMethods.mkdirSync;
        fs.renameSync = originalMethods.renameSync;
        fs.rmSync = originalMethods.rmSync;
        fs.unlinkSync = originalMethods.unlinkSync;
        fs.writeFileSync = originalMethods.writeFileSync;
        console.error = originalMethods.error;
        console.log = originalMethods.log;
        console.warn = originalMethods.warn;

        delete require.cache[LIFECYCLE_PATH];
        delete require.cache[FACTORY_PATH];
        delete require.cache[PLAN_PATH];

        if (cachedLifecycle)
        {
            require.cache[LIFECYCLE_PATH] = cachedLifecycle;
        }

        if (cachedFactory)
        {
            require.cache[FACTORY_PATH] = cachedFactory;
        }

        if (cachedPlan)
        {
            require.cache[PLAN_PATH] = cachedPlan;
        }

        assert.deepEqual(snapshotTree(workspace.sourceRoot), sourceBefore);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
        removeWorkspace(workspace.workspace);
    }
});

test("invalid and missing roots return 2 without constructing Webpack", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    const diagnostics = [];
    let webpackCalls = 0;
    const runtime = validRuntime(() => {
        webpackCalls += 1;

        return successfulCompiler({ close: 0, run: 0 });
    }, diagnostic => diagnostics.push(diagnostic));
    const cases = [
        undefined,
        {},
        {
            outputRoot: workspace.outputRoot,
            sourceRoot: "relative-source",
        },
        {
            outputRoot: "relative-output",
            sourceRoot: workspace.sourceRoot,
        },
        {
            outputRoot: workspace.outputRoot,
            sourceRoot: path.join(workspace.workspace, "missing-source"),
        },
    ];

    try
    {
        for (const options of cases)
        {
            assert.equal(await runComponentBuild(options, runtime), 2);
        }

        assert.equal(webpackCalls, 0);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
        assert.ok(diagnostics.every(diagnostic =>
            ["usage", "plan"].includes(diagnostic.phase)));
        assert.ok(diagnostics.every(diagnostic =>
            typeof diagnostic.message === "string"));
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("an existing output root is rejected as a non-fresh destination", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    fs.mkdirSync(workspace.outputRoot);
    const outputBefore = snapshotTree(workspace.outputRoot);
    let webpackCalls = 0;

    try
    {
        const status = await runComponentBuild(workspace, validRuntime(() => {
            webpackCalls += 1;

            return successfulCompiler({ close: 0, run: 0 });
        }));

        assert.equal(status, 2);
        assert.equal(webpackCalls, 0);
        assert.deepEqual(snapshotTree(workspace.outputRoot), outputBefore);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("invalid runtime wiring returns 2 and never calls Webpack", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    let webpackCalls = 0;
    const countedWebpack = () => {
        webpackCalls += 1;

        return successfulCompiler({ close: 0, run: 0 });
    };
    const runtimes = [
        undefined,
        {},
        {
            adapters: ADAPTERS,
            webpack: "not-a-function",
        },
        {
            webpack: countedWebpack,
        },
        {
            adapters: {},
            webpack: countedWebpack,
        },
        {
            adapters: ADAPTERS,
            reportDiagnostic: "not-a-function",
            webpack: countedWebpack,
        },
    ];

    try
    {
        for (const runtime of runtimes)
        {
            assert.equal(await runComponentBuild(workspace, runtime), 2);
        }

        assert.equal(webpackCalls, 0);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("the frozen Component target produces the accepted 72/144 definition", async () => {
    const workspace = makeWorkspace("sf-component-72-");
    writeComponentFixture(workspace.sourceRoot, 72, 4);
    writeFile(
        workspace.sourceRoot,
        "component/entry-000/template/ignored.html",
        "<div>ignored</div>\n",
    );
    const sourceBefore = snapshotTree(workspace.sourceRoot);
    let observedDefinition;
    let observedOptions;
    let observedAdapters;
    let webpackConfigurations;
    const counts = {
        close: 0,
        run: 0,
        webpack: 0,
    };
    const isolated = loadLifecycleWithFactory((options, adapters) => {
        observedOptions = options;
        observedAdapters = adapters;
        observedDefinition = createWebpackBuildDefinition(options, adapters);

        return observedDefinition;
    });

    try
    {
        const status = await isolated.runComponentBuild({
            ...workspace,
            configurationPoliciesByTarget: {
                component: {
                    devtool: true,
                    postcss: {
                        plugins: [["forbidden-plugin", {}]],
                    },
                    resolveExtensions: [".forbidden"],
                    target: "forbidden",
                    output: {
                        pathinfo: true,
                        publicPath: "/forbidden/",
                    },
                },
                forbidden: componentConfigurationPolicy(),
            },
            sassResourcesByTarget: {
                component: [path.join(workspace.sourceRoot, "forbidden.scss")],
            },
            targets: [{
                directory: "forbidden",
                entryPriority: ["other.js"],
                name: "forbidden",
                outputPrefix: "forbidden",
                templateLayouts: ["template"],
            }],
        }, validRuntime(configurations => {
            counts.webpack += 1;
            webpackConfigurations = configurations;

            return successfulCompiler(counts);
        }));

        assert.equal(status, 0);
        assert.equal(counts.webpack, 1);
        assert.equal(counts.run, 1);
        assert.equal(counts.close, 1);
        assert.equal(observedAdapters, ADAPTERS);
        assert.deepEqual(observedOptions, {
            configurationPoliciesByTarget: {
                component: componentConfigurationPolicy(),
            },
            outputRoot: workspace.outputRoot,
            sassResourcesByTarget: {
                component: [],
            },
            sourceRoot: workspace.sourceRoot,
            targets: [{
                directory: "component",
                entryPriority: ["index.js", "index.scss"],
                name: "component",
                outputPrefix: "component",
                templateLayouts: [],
            }],
        });
        assert.ok(Object.isFrozen(observedOptions.targets));
        assert.ok(Object.isFrozen(observedOptions.targets[0]));
        assert.ok(Object.isFrozen(observedOptions.targets[0].entryPriority));
        assert.ok(Object.isFrozen(observedOptions.targets[0].templateLayouts));
        assert.ok(Object.isFrozen(observedOptions.sassResourcesByTarget));
        assert.ok(Object.isFrozen(
            observedOptions.sassResourcesByTarget.component,
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget,
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget.component,
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget.component.postcss,
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget
                .component.postcss.plugins,
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget
                .component.postcss.plugins[0],
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget
                .component.postcss.plugins[0][1],
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget
                .component.postcss.plugins[0][1].autoprefixer,
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget
                .component.resolveExtensions,
        ));
        assert.ok(Object.isFrozen(
            observedOptions.configurationPoliciesByTarget.component.output,
        ));
        assert.equal(observedDefinition.plan.entries.length, 72);
        assert.equal(observedDefinition.configurations.length, 144);
        assert.equal(webpackConfigurations, observedDefinition.configurations);
        assert.deepEqual(observedDefinition.templateCopies, []);
        assert.ok(observedDefinition.plan.entries.every(entry =>
            entry.target === "component"
            && entry.key.startsWith("component/")));
        assert.equal(observedDefinition.plan.entries.filter(entry =>
            path.extname(entry.input) === ".js").length, 68);
        assert.equal(observedDefinition.plan.entries.filter(entry =>
            path.extname(entry.input) === ".scss").length, 4);
        const policyReferences = {
            autoprefixer: new Set(),
            output: new Set(),
            pluginOptions: new Set(),
            pluginTuples: new Set(),
            plugins: new Set(),
            postcssOptions: new Set(),
            resolveExtensions: new Set(),
        };

        for (const [entryIndex, entry]
            of observedDefinition.plan.entries.entries())
        {
            const raw = observedDefinition.configurations[entryIndex * 2];
            const minified = observedDefinition.configurations[
                (entryIndex * 2) + 1
            ];

            assert.deepEqual(Object.keys(raw.entry), [entry.key]);
            assert.deepEqual(Object.keys(minified.entry), [entry.key]);
            assert.equal(raw.mode, "development");
            assert.equal(minified.mode, "production");

            for (const configuration of [raw, minified])
            {
                const javascriptRule = configuration.module.rules[0];
                const styles = styleRule(configuration);
                const postcss = postcssLoader(configuration);
                const plugins = postcss.options.postcssOptions.plugins;

                assert.equal(configuration.devtool, false);
                assert.equal(configuration.target, "web");
                assert.deepEqual(configuration.resolve, {
                    conditionNames: [
                        "webpack",
                        "browser",
                        "production",
                        "import",
                        "default",
                    ],
                    extensions: [".js", ".scss"],
                });
                assert.equal(configuration.output.pathinfo, false);
                assert.deepEqual(postcss.options, {
                    postcssOptions: {
                        plugins: componentConfigurationPolicy()
                            .postcss.plugins,
                    },
                });
                assert.deepEqual(styles.use[0], {
                    loader: MiniCssExtractPluginStub.loader,
                });
                assert.equal(
                    Object.hasOwn(configuration.output, "publicPath"),
                    false,
                );
                assert.equal(
                    Object.hasOwn(
                        configuration.output,
                        "assetModuleFilename",
                    ),
                    false,
                );
                assert.equal(
                    Object.hasOwn(configuration.output, "clean"),
                    false,
                );
                assert.equal(
                    Object.hasOwn(configuration, "experiments"),
                    false,
                );
                assert.equal(Object.hasOwn(javascriptRule, "issuer"), false);
                assert.equal(Object.hasOwn(styles.use[0], "options"), false);
                assert.ok(configuration.plugins.every(plugin =>
                    plugin instanceof MiniCssExtractPluginStub
                    || plugin instanceof RemoveEmptyScriptsPluginStub));

                policyReferences.autoprefixer.add(
                    plugins[0][1].autoprefixer,
                );
                policyReferences.output.add(configuration.output);
                policyReferences.pluginOptions.add(plugins[0][1]);
                policyReferences.pluginTuples.add(plugins[0]);
                policyReferences.plugins.add(plugins);
                policyReferences.postcssOptions.add(
                    postcss.options.postcssOptions,
                );
                policyReferences.resolveExtensions.add(
                    configuration.resolve.extensions,
                );
            }
        }

        for (const references of Object.values(policyReferences))
        {
            assert.equal(
                references.size,
                observedDefinition.configurations.length,
            );
        }

        assert.deepEqual(snapshotTree(workspace.sourceRoot), sourceBefore);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("success calls Webpack, run and close exactly once", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    const sourceBefore = snapshotTree(workspace.sourceRoot);
    const diagnostics = [];
    const counts = {
        close: 0,
        run: 0,
        webpack: 0,
    };
    let configurations;

    try
    {
        const status = await runComponentBuild(
            workspace,
            validRuntime(receivedConfigurations => {
                counts.webpack += 1;
                configurations = receivedConfigurations;

                return successfulCompiler(counts);
            }, diagnostic => diagnostics.push(diagnostic)),
        );

        assert.equal(status, 0);
        assert.deepEqual(counts, {
            close: 1,
            run: 1,
            webpack: 1,
        });
        assert.equal(configurations.length, 2);
        assert.deepEqual(diagnostics, []);
        assert.deepEqual(snapshotTree(workspace.sourceRoot), sourceBefore);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("Utility entryKeys filter configurations and packaging plan fail closed", async () => {
    const workspace = makeWorkspace("sf-utility-entry-filter-");
    const diagnostics = [];
    let observedConfigurations;

    writeFile(workspace.sourceRoot, "core/scss/.keep", "");
    writeFile(
        workspace.sourceRoot,
        "utility/alpha/default/index.scss",
        ".alpha {}\n",
    );
    writeFile(
        workspace.sourceRoot,
        "utility/beta/default/index.scss",
        ".beta {}\n",
    );

    try
    {
        const status = await runUtilityBuild({
            entryKeys: ["utility/beta/default"],
            outputRoot: workspace.outputRoot,
            sourceRoot: workspace.sourceRoot,
        }, validRuntime(configurations => {
            observedConfigurations = configurations;
            return successfulCompiler({ close: 0, run: 0 });
        }, diagnostic => diagnostics.push(diagnostic)));

        assert.equal(status, 0);
        assert.deepEqual(diagnostics, []);
        assert.equal(observedConfigurations.length, 2);
        assert.ok(observedConfigurations.every(configuration =>
            Object.keys(configuration.entry)[0] === "utility/beta/default"));

        const missingDiagnostics = [];
        const missingStatus = await runUtilityBuild({
            entryKeys: ["utility/missing/default"],
            outputRoot: path.join(workspace.workspace, "missing-output"),
            sourceRoot: workspace.sourceRoot,
        }, validRuntime(() => {
            throw new Error("Webpack must not run for an unknown entry");
        }, diagnostic => missingDiagnostics.push(diagnostic)));

        assert.equal(missingStatus, 2);
        assert.equal(missingDiagnostics.length, 1);
        assert.equal(missingDiagnostics[0].phase, "plan");
        assert.match(missingDiagnostics[0].message, /unknown entries/);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("a synchronous Webpack construction throw returns 1 without a close", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    const diagnostics = [];
    const counts = {
        close: 0,
        run: 0,
        webpack: 0,
    };

    try
    {
        const status = await runComponentBuild(
            workspace,
            validRuntime(() => {
                counts.webpack += 1;
                throw new Error("construction failed");
            }, diagnostic => diagnostics.push(diagnostic)),
        );

        assert.equal(status, 1);
        assert.deepEqual(counts, {
            close: 0,
            run: 0,
            webpack: 1,
        });
        assert.deepEqual(
            diagnostics.map(diagnostic => diagnostic.phase),
            ["webpack"],
        );
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("compiler, stats and close failures return 1 with one close", async t => {
    const cases = [
        {
            close(callback)
            {
                callback();
            },
            expectedPhases: ["run"],
            name: "synchronous run throw",
            run()
            {
                throw new Error("run threw");
            },
        },
        {
            close(callback)
            {
                callback();
            },
            expectedPhases: ["run"],
            name: "run callback error",
            run(callback)
            {
                callback(new Error("run failed"));
            },
        },
        {
            close(callback)
            {
                callback();
            },
            expectedPhases: ["stats"],
            name: "missing stats",
            run(callback)
            {
                callback(null);
            },
        },
        {
            close(callback)
            {
                callback();
            },
            expectedPhases: ["stats"],
            name: "invalid stats",
            run(callback)
            {
                callback(null, {});
            },
        },
        {
            close(callback)
            {
                callback();
            },
            expectedPhases: ["stats"],
            name: "stats has errors",
            run(callback)
            {
                callback(null, {
                    hasErrors()
                    {
                        return true;
                    },
                });
            },
        },
        {
            close(callback)
            {
                callback();
            },
            expectedPhases: ["stats"],
            name: "stats hasErrors throws",
            run(callback)
            {
                callback(null, {
                    hasErrors()
                    {
                        throw new Error("stats inspection failed");
                    },
                });
            },
        },
        {
            close(callback)
            {
                callback(new Error("close failed"));
            },
            expectedPhases: ["close"],
            name: "close callback error",
            run(callback)
            {
                callback(null, successfulStats());
            },
        },
        {
            close()
            {
                throw new Error("close threw");
            },
            expectedPhases: ["close"],
            name: "synchronous close throw",
            run(callback)
            {
                callback(null, successfulStats());
            },
        },
    ];

    for (const failureCase of cases)
    {
        await t.test(failureCase.name, async () => {
            const workspace = makeWorkspace();
            writeComponentFixture(workspace.sourceRoot);
            const sourceBefore = snapshotTree(workspace.sourceRoot);
            const diagnostics = [];
            const counts = {
                close: 0,
                run: 0,
                webpack: 0,
            };
            const compiler = {
                close(callback)
                {
                    counts.close += 1;

                    return failureCase.close(callback);
                },
                run(callback)
                {
                    counts.run += 1;

                    return failureCase.run(callback);
                },
            };

            try
            {
                const status = await runComponentBuild(
                    workspace,
                    validRuntime(() => {
                        counts.webpack += 1;

                        return compiler;
                    }, diagnostic => diagnostics.push(diagnostic)),
                );

                assert.equal(status, 1);
                assert.deepEqual(counts, {
                    close: 1,
                    run: 1,
                    webpack: 1,
                });
                assert.deepEqual(
                    diagnostics.map(diagnostic => diagnostic.phase),
                    failureCase.expectedPhases,
                );
                assert.ok(diagnostics.every(diagnostic =>
                    typeof diagnostic.message === "string"));
                assert.deepEqual(
                    snapshotTree(workspace.sourceRoot),
                    sourceBefore,
                );
                assert.equal(fs.existsSync(workspace.outputRoot), false);
            }
            finally
            {
                removeWorkspace(workspace.workspace);
            }
        });
    }
});

test("invalid compiler methods fail closed and close when callable", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    const diagnostics = [];
    let closeCalls = 0;
    let webpackCalls = 0;

    try
    {
        const missingRunStatus = await runComponentBuild(
            workspace,
            validRuntime(() => {
                webpackCalls += 1;

                return {
                    close(callback)
                    {
                        closeCalls += 1;
                        callback();
                    },
                };
            }, diagnostic => diagnostics.push(diagnostic)),
        );
        const missingCloseStatus = await runComponentBuild(
            workspace,
            validRuntime(() => {
                webpackCalls += 1;

                return {
                    run()
                    {
                        throw new Error("must not run");
                    },
                };
            }, diagnostic => diagnostics.push(diagnostic)),
        );

        assert.equal(missingRunStatus, 1);
        assert.equal(missingCloseStatus, 1);
        assert.equal(webpackCalls, 2);
        assert.equal(closeCalls, 1);
        assert.deepEqual(
            diagnostics.map(diagnostic => diagnostic.phase),
            ["run", "close"],
        );
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("duplicate run and close callbacks cannot double-close or change status", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    const diagnostics = [];
    const counts = {
        close: 0,
        run: 0,
        webpack: 0,
    };

    try
    {
        const status = await runComponentBuild(
            workspace,
            validRuntime(() => {
                counts.webpack += 1;

                return {
                    close(callback)
                    {
                        counts.close += 1;
                        callback();
                        callback(new Error("late close callback"));
                        queueMicrotask(() =>
                            callback(new Error("later close callback")));
                    },
                    run(callback)
                    {
                        counts.run += 1;
                        callback(null, successfulStats());
                        callback(new Error("late run callback"));
                        queueMicrotask(() =>
                            callback(new Error("later run callback")));
                    },
                };
            }, diagnostic => diagnostics.push(diagnostic)),
        );

        await Promise.resolve();
        assert.equal(status, 0);
        assert.deepEqual(counts, {
            close: 1,
            run: 1,
            webpack: 1,
        });
        assert.deepEqual(diagnostics, []);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("a throwing diagnostic reporter never replaces status", async () => {
    const workspace = makeWorkspace();
    writeComponentFixture(workspace.sourceRoot);
    let reportCalls = 0;
    const throwingReporter = () => {
        reportCalls += 1;
        throw new Error("reporter failed");
    };

    try
    {
        const usageStatus = await runComponentBuild({
            outputRoot: workspace.outputRoot,
            sourceRoot: "relative",
        }, validRuntime(() => {
            throw new Error("must not construct");
        }, throwingReporter));
        const webpackStatus = await runComponentBuild(
            workspace,
            validRuntime(() => {
                throw new Error("construction failed");
            }, throwingReporter),
        );

        assert.equal(usageStatus, 2);
        assert.equal(webpackStatus, 1);
        assert.equal(reportCalls, 2);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("lifecycle source contains no environment, exit, logging or package side effects", () => {
    const source = fs.readFileSync(LIFECYCLE_PATH, "utf8");

    assert.doesNotMatch(source, /process\.(?:env|exit|exitCode)/);
    assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/);
    assert.doesNotMatch(source, /\b(?:ProvidePlugin|CleanWebpackPlugin)\b/);
    assert.doesNotMatch(
        source,
        /\b(?:publicPath|assetModuleFilename|experiments)\b/,
    );
    assert.doesNotMatch(
        source,
        /\b(?:exec|spawn|fork|watch|listen)\s*\(/,
    );
    assert.doesNotMatch(
        source,
        /\brequire\s*\(\s*["'](?!node:|\.{1,2}\/)[^"']+["']\s*\)/,
    );
    assert.doesNotMatch(
        source,
        /\b(?:writeFile|appendFile|copyFile|mkdir|rm|unlink|rename)\w*Sync\b/,
    );
});
