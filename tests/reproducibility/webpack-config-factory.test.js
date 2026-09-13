"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    DEFAULT_TARGETS,
    createBuildPlan,
} = require("../../libs/buildPlan");
const {
    createWebpackBuildDefinition,
} = require("../../libs/webpackConfigFactory");
const {
    createPostcssPlugins,
} = require("../../libs/postcssPolicy");

const FACTORY_PATH = require.resolve("../../libs/webpackConfigFactory");
const PLAN_PATH = require.resolve("../../libs/buildPlan");

const FIXTURE_FILES = [
    ["component/button/index.js", "module.exports = 'component';\n"],
    ["core/index.js", "module.exports = 'core';\n"],
    ["core/rule.js", "module.exports = 'rule';\n"],
    ["smart/card/index.scss", ".card {}\n"],
    ["smart/card/js/templates/interactive.js", "export default {};\n"],
    ["smart/card/template/default.html", "<div></div>\n"],
    ["utility/space/default/index.scss", ".space {}\n"],
];

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

function configurationPolicy(overrides = {})
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
        ...overrides,
    };
}

function configurationPoliciesForTargets(targets)
{
    const policies = {};

    for (const target of targets)
    {
        if (target
            && typeof target === "object"
            && typeof target.name === "string"
            && target.name.length > 0)
        {
            policies[target.name] = configurationPolicy();
        }
    }

    return policies;
}

function makeWorkspace()
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-webpack-factory-"));

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

function writeFiles(root, files)
{
    for (const [relativePath, content] of files)
    {
        const destination = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
    }
}

function snapshotTree(root)
{
    const snapshot = [];

    function visit(directory, relativeDirectory)
    {
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));

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
                snapshot.push(`symlink:${relativePath}:${fs.readlinkSync(absolutePath)}`);
            }
            else
            {
                snapshot.push(
                    `file:${relativePath}:${
                        crypto.createHash("sha256")
                            .update(fs.readFileSync(absolutePath))
                            .digest("hex")
                    }`,
                );
            }
        }
    }

    visit(root, "");

    return snapshot;
}

function defaultResourceMap(overrides = {})
{
    return {
        component: [],
        core: [],
        smart: [],
        utility: [],
        ...overrides,
    };
}

function defaultOptions(workspace, overrides = {})
{
    const targets = Object.prototype.hasOwnProperty.call(overrides, "targets")
        ? overrides.targets
        : DEFAULT_TARGETS;

    return {
        ...workspace,
        configurationPoliciesByTarget: Array.isArray(targets)
            ? configurationPoliciesForTargets(targets)
            : {},
        sassResourcesByTarget: defaultResourceMap(),
        targets,
        ...overrides,
    };
}

function componentTarget(overrides = {})
{
    return {
        directory: "component",
        entryPriority: ["index.js", "index.scss"],
        name: "component",
        outputPrefix: "component",
        ...overrides,
    };
}

function componentOptions(workspace, overrides = {})
{
    const targets = Object.prototype.hasOwnProperty.call(overrides, "targets")
        ? overrides.targets
        : [componentTarget()];

    return {
        ...workspace,
        configurationPoliciesByTarget: Array.isArray(targets)
            ? configurationPoliciesForTargets(targets)
            : {},
        sassResourcesByTarget: {
            component: [],
        },
        targets,
        ...overrides,
    };
}

function makeFixture()
{
    const workspace = makeWorkspace();
    writeFiles(workspace.sourceRoot, FIXTURE_FILES);

    return workspace;
}

function configKey(configuration)
{
    return Object.keys(configuration.entry)[0];
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

function factorySource()
{
    return fs.readFileSync(FACTORY_PATH, "utf8");
}

test("missing and non-absolute roots fail through the planner", () => {
    const workspace = makeWorkspace();

    try
    {
        assert.throws(
            () => createWebpackBuildDefinition(
                componentOptions(workspace),
                ADAPTERS,
            ),
            /sourceRoot does not exist/,
        );
        assert.throws(
            () => createWebpackBuildDefinition(
                componentOptions(workspace, {
                    sourceRoot: "relative/source",
                }),
                ADAPTERS,
            ),
            /sourceRoot must be a non-empty absolute path/,
        );

        writeFiles(workspace.sourceRoot, [
            ["component/card/index.js", "module.exports = {};\n"],
        ]);

        assert.throws(
            () => createWebpackBuildDefinition(
                componentOptions(workspace, {
                    outputRoot: "relative/output",
                }),
                ADAPTERS,
            ),
            /outputRoot must be a non-empty absolute path/,
        );
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("targets and every selected target resource array are mandatory", () => {
    const workspace = makeFixture();

    try
    {
        assert.throws(
            () => createWebpackBuildDefinition({
                ...workspace,
                sassResourcesByTarget: {},
            }, ADAPTERS),
            /targets must be a non-empty array/,
        );
        assert.throws(
            () => createWebpackBuildDefinition({
                ...workspace,
                sassResourcesByTarget: {},
                targets: [],
            }, ADAPTERS),
            /targets must be a non-empty array/,
        );
        assert.throws(
            () => createWebpackBuildDefinition(
                defaultOptions(workspace, {
                    sassResourcesByTarget: {
                        component: [],
                        core: [],
                        utility: [],
                    },
                }),
                ADAPTERS,
            ),
            /sassResourcesByTarget\.smart must be an explicit array/,
        );
        assert.throws(
            () => createWebpackBuildDefinition(
                defaultOptions(workspace, {
                    sassResourcesByTarget: defaultResourceMap({
                        smart: "not-an-array",
                    }),
                }),
                ADAPTERS,
            ),
            /sassResourcesByTarget\.smart must be an explicit array/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("per-target policies are mandatory, exact and fail before adapter construction", () => {
    const workspace = makeFixture();
    const constructions = {
        miniCss: 0,
        removeEmpty: 0,
        terser: 0,
    };

    class CountingMiniCssExtractPlugin
    {
        static loader = "mini-css-extract-loader-counting";

        constructor()
        {
            constructions.miniCss += 1;
        }
    }

    class CountingRemoveEmptyScriptsPlugin
    {
        constructor()
        {
            constructions.removeEmpty += 1;
        }
    }

    class CountingTerserPlugin
    {
        constructor()
        {
            constructions.terser += 1;
        }
    }

    const adapters = {
        MiniCssExtractPlugin: CountingMiniCssExtractPlugin,
        RemoveEmptyScriptsPlugin: CountingRemoveEmptyScriptsPlugin,
        TerserPlugin: CountingTerserPlugin,
    };
    const withoutPolicy = componentOptions(workspace);
    delete withoutPolicy.configurationPoliciesByTarget;
    const missingRootKey = configurationPolicy();
    delete missingRootKey.target;
    const accessorPolicy = configurationPolicy();
    Object.defineProperty(accessorPolicy, "target", {
        enumerable: true,
        get()
        {
            throw new Error("policy accessor must not execute");
        },
    });
    const accessorMap = {};
    Object.defineProperty(accessorMap, "component", {
        enumerable: true,
        get()
        {
            throw new Error("policy-map accessor must not execute");
        },
    });
    const symbolPolicy = configurationPolicy();
    symbolPolicy[Symbol("unknown")] = true;
    const globallyInvalidOptions = defaultOptions(workspace);
    globallyInvalidOptions.configurationPoliciesByTarget[
        DEFAULT_TARGETS.at(-1).name
    ].devtool = true;
    const sparsePluginTuple = ["plugin"];
    sparsePluginTuple.length = 2;
    const cases = [
        withoutPolicy,
        globallyInvalidOptions,
        componentOptions(workspace, {
            configurationPoliciesByTarget: {},
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: accessorMap,
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: accessorPolicy,
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: symbolPolicy,
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy(),
                extra: configurationPolicy(),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: {
                    ...configurationPolicy(),
                    unknown: true,
                },
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: missingRootKey,
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    devtool: true,
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    output: {
                        pathinfo: true,
                    },
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    output: {
                        pathinfo: false,
                        publicPath: "/",
                    },
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    postcss: {
                        extra: true,
                        plugins: [],
                    },
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    postcss: {
                        plugins: "not-an-array",
                    },
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    postcss: {
                        plugins: [["", {}]],
                    },
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    postcss: {
                        plugins: [["plugin", {}, "extra"]],
                    },
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    postcss: {
                        plugins: [sparsePluginTuple],
                    },
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    resolveExtensions: [],
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    resolveExtensions: [".js", ".js"],
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    resolveExtensions: [".js", "scss"],
                }),
            },
        }),
        componentOptions(workspace, {
            configurationPoliciesByTarget: {
                component: configurationPolicy({
                    target: "",
                }),
            },
        }),
    ];

    try
    {
        for (const options of cases)
        {
            assert.throws(
                () => createWebpackBuildDefinition(options, adapters),
                /configurationPoliciesByTarget/,
            );
        }

        assert.deepEqual(constructions, {
            miniCss: 0,
            removeEmpty: 0,
            terser: 0,
        });
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("dangerous, cyclic, accessor and non-plain plugin options fail closed", () => {
    const workspace = makeFixture();
    const cyclic = {};
    cyclic.self = cyclic;
    const sparse = [];
    sparse[1] = "value";
    const largeSparse = new Array(1_000_000);
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
        enumerable: true,
        get()
        {
            throw new Error("accessor must not execute");
        },
    });
    const symbolKey = {
        safe: true,
    };
    symbolKey[Symbol("unsafe")] = true;
    const dangerousKey = {};
    Object.defineProperty(dangerousKey, "__proto__", {
        enumerable: true,
        value: {},
    });
    const dangerousPrototype = {
        prototype: {},
    };
    const accessorArray = ["value"];
    Object.defineProperty(accessorArray, "0", {
        enumerable: true,
        get()
        {
            throw new Error("array accessor must not execute");
        },
    });
    const symbolArray = [];
    symbolArray[Symbol("unsafe")] = true;
    const nonEnumerableArray = [];
    Object.defineProperty(nonEnumerableArray, "0", {
        enumerable: false,
        value: "hidden",
    });
    const nonEnumerableObject = {};
    Object.defineProperty(nonEnumerableObject, "hidden", {
        enumerable: false,
        value: true,
    });
    const customArray = [];
    Object.setPrototypeOf(customArray, {});
    const invalidOptions = [
        cyclic,
        sparse,
        largeSparse,
        accessor,
        new Date(0),
        Object.create(null),
        symbolKey,
        dangerousKey,
        dangerousPrototype,
        accessorArray,
        symbolArray,
        nonEnumerableArray,
        nonEnumerableObject,
        {
            nested: {
                constructor: "unsafe",
            },
        },
        customArray,
        undefined,
        Symbol("value"),
        () => true,
        Number.POSITIVE_INFINITY,
    ];
    let adapterConstructions = 0;

    class CountingMiniCssExtractPlugin
    {
        static loader = "mini-css-extract-loader-counting";

        constructor()
        {
            adapterConstructions += 1;
        }
    }

    class CountingRemoveEmptyScriptsPlugin
    {
        constructor()
        {
            adapterConstructions += 1;
        }
    }

    class CountingTerserPlugin
    {
        constructor()
        {
            adapterConstructions += 1;
        }
    }

    const adapters = {
        MiniCssExtractPlugin: CountingMiniCssExtractPlugin,
        RemoveEmptyScriptsPlugin: CountingRemoveEmptyScriptsPlugin,
        TerserPlugin: CountingTerserPlugin,
    };

    try
    {
        for (const options of invalidOptions)
        {
            assert.throws(
                () => createWebpackBuildDefinition(
                    componentOptions(workspace, {
                        configurationPoliciesByTarget: {
                            component: configurationPolicy({
                                postcss: {
                                    plugins: [["plugin", options]],
                                },
                            }),
                        },
                    }),
                    adapters,
                ),
                /configurationPoliciesByTarget/,
            );
        }

        assert.equal(adapterConstructions, 0);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("policy values materialize exactly while deferred and dropped keys stay absent", () => {
    const workspace = makeFixture();

    try
    {
        const definition = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );
        const expectedPlugins = configurationPolicy().postcss.plugins;
        const policyReferences = {
            autoprefixer: new Set(),
            output: new Set(),
            pluginOptions: new Set(),
            pluginTuples: new Set(),
            plugins: new Set(),
            postcssOptions: new Set(),
            resolveExtensions: new Set(),
        };

        for (const configuration of definition.configurations)
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
                    plugins: expectedPlugins,
                },
            });
            assert.deepEqual(styles.use[0], {
                loader: MiniCssExtractPluginStub.loader,
            });
            assert.equal(Object.hasOwn(configuration.output, "publicPath"), false);
            assert.equal(
                Object.hasOwn(configuration.output, "assetModuleFilename"),
                false,
            );
            assert.equal(Object.hasOwn(configuration.output, "clean"), false);
            assert.equal(Object.hasOwn(configuration, "experiments"), false);
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

        for (const references of Object.values(policyReferences))
        {
            assert.equal(
                references.size,
                definition.configurations.length,
            );
        }
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("caller and configuration policy mutations are isolated at every nested level", () => {
    const workspace = makeFixture();
    const policy = configurationPolicy({
        postcss: {
            plugins: [
                ["null-options", null],
                ["boolean-options", true],
                ["number-options", 4],
                ["string-options", "value"],
                ["array-options", [{ nested: ["original"] }]],
                ["object-options", {
                    nested: {
                        enabled: true,
                    },
                }],
                ["postcss-preset-env", {
                    features: {
                        "dir-pseudo-class": false,
                        "logical-properties-and-values": {
                            preserve: true,
                        },
                    },
                }],
                createPostcssPlugins()[1],
            ],
        },
    });
    const options = componentOptions(workspace, {
        configurationPoliciesByTarget: {
            component: policy,
        },
    });

    try
    {
        const definition = createWebpackBuildDefinition(options, ADAPTERS);
        const raw = definition.configurations[0];
        const minified = definition.configurations[1];
        const rawPlugins = postcssLoader(raw).options.postcssOptions.plugins;
        const minifiedPlugins = postcssLoader(minified)
            .options.postcssOptions.plugins;

        assert.deepEqual(rawPlugins, policy.postcss.plugins);
        assert.notEqual(raw.resolve.extensions, minified.resolve.extensions);
        assert.notEqual(raw.resolve.extensions, policy.resolveExtensions);
        assert.notEqual(rawPlugins, minifiedPlugins);
        assert.notEqual(rawPlugins, policy.postcss.plugins);
        assert.notEqual(rawPlugins[4], minifiedPlugins[4]);
        assert.notEqual(rawPlugins[4][1], minifiedPlugins[4][1]);
        assert.notEqual(rawPlugins[4][1][0], minifiedPlugins[4][1][0]);
        assert.notEqual(
            rawPlugins[4][1][0].nested,
            minifiedPlugins[4][1][0].nested,
        );
        assert.notEqual(rawPlugins[5][1], minifiedPlugins[5][1]);
        assert.notEqual(
            rawPlugins[5][1].nested,
            minifiedPlugins[5][1].nested,
        );

        policy.resolveExtensions.push(".caller");
        policy.postcss.plugins[4][1][0].nested.push("caller");
        raw.resolve.extensions.push(".raw");
        rawPlugins[4][1][0].nested.push("raw");
        rawPlugins[5][1].nested.enabled = false;

        for (const configuration of definition.configurations.slice(1))
        {
            const plugins = postcssLoader(configuration)
                .options.postcssOptions.plugins;

            assert.deepEqual(
                configuration.resolve.extensions,
                [".js", ".scss"],
            );
            assert.deepEqual(plugins[4][1][0].nested, ["original"]);
            assert.equal(plugins[5][1].nested.enabled, true);
        }

        assert.deepEqual(minified.resolve.extensions, [".js", ".scss"]);
        assert.deepEqual(minifiedPlugins[4][1][0].nested, ["original"]);
        assert.equal(minifiedPlugins[5][1].nested.enabled, true);
        assert.deepEqual(
            policy.postcss.plugins[4][1][0].nested,
            ["original", "caller"],
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("all five semantic entries produce deterministic raw and minified pairs", () => {
    const workspace = makeFixture();

    try
    {
        const first = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );
        const second = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        assert.deepEqual(
            first.plan.entries.map(entry => entry.key),
            [
                "component/button",
                "core",
                "rule",
                "smart/card",
                "utility/space/default",
            ],
        );
        assert.equal(first.configurations.length, 10);
        assert.deepEqual(
            first.configurations.map(configuration => ({
                key: configKey(configuration),
                mode: configuration.mode,
            })),
            first.plan.entries.flatMap(entry => [
                { key: entry.key, mode: "development" },
                { key: entry.key, mode: "production" },
            ]),
        );
        assert.deepEqual(second, first);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("entry and raw/min JS and CSS paths are derived only from each plan entry", () => {
    const workspace = makeFixture();

    try
    {
        const definition = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        for (const [entryIndex, entry] of definition.plan.entries.entries())
        {
            const leaf = entry.key.split("/").at(-1);
            const raw = definition.configurations[entryIndex * 2];
            const minified = definition.configurations[(entryIndex * 2) + 1];

            assert.deepEqual(raw.entry, { [entry.key]: entry.input });
            assert.deepEqual(minified.entry, { [entry.key]: entry.input });
            assert.equal(raw.context, definition.plan.sourceRoot);
            assert.equal(minified.context, definition.plan.sourceRoot);
            assert.equal(raw.output.path, entry.outputDirectory);
            assert.equal(minified.output.path, entry.outputDirectory);
            assert.equal(raw.output.filename, `js/${leaf}.js`);
            assert.equal(minified.output.filename, `js/${leaf}.min.js`);
            assert.equal(raw.output.chunkFilename, "js/[name].js");
            assert.equal(minified.output.chunkFilename, "js/[name].min.js");
            assert.equal(raw.plugins[0].options.filename, `css/${leaf}.css`);
            assert.equal(
                minified.plugins[0].options.filename,
                `css/${leaf}.min.css`,
            );
        }
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("minification is unambiguous and cannot be overwritten by a duplicate key", () => {
    const workspace = makeFixture();

    try
    {
        const definition = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        for (let index = 0; index < definition.configurations.length; index += 2)
        {
            const raw = definition.configurations[index];
            const minified = definition.configurations[index + 1];

            assert.equal(raw.mode, "development");
            assert.equal(minified.mode, "production");
            assert.deepEqual(raw.optimization, {
                chunkIds: "deterministic",
                minimize: false,
                moduleIds: "deterministic",
                nodeEnv: "production",
            });
            assert.equal(minified.optimization.chunkIds, "deterministic");
            assert.equal(minified.optimization.minimize, true);
            assert.equal(minified.optimization.moduleIds, "deterministic");
            assert.equal(minified.optimization.nodeEnv, "production");
            assert.equal(minified.optimization.minimizer.length, 1);
            assert.ok(
                minified.optimization.minimizer[0] instanceof TerserPluginStub,
            );
            assert.equal(
                Object.keys(minified).filter(key => key === "optimization").length,
                1,
            );
        }

        assert.equal(
            (factorySource().match(/\boptimization\s*:/g) || []).length,
            1,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("watch, cache and devtool remain disabled in every configuration", () => {
    const workspace = makeFixture();

    try
    {
        const definition = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        for (const configuration of definition.configurations)
        {
            assert.equal(configuration.watch, false);
            assert.equal(configuration.cache, false);
            assert.equal(configuration.devtool, false);
        }
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("SCSS entries receive remove-empty while JS entries do not", () => {
    const workspace = makeFixture();

    try
    {
        const definition = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        for (const [entryIndex, entry] of definition.plan.entries.entries())
        {
            const expected = path.extname(entry.input) === ".scss" ? 1 : 0;

            for (const configuration of definition.configurations.slice(
                entryIndex * 2,
                (entryIndex * 2) + 2,
            ))
            {
                assert.equal(
                    configuration.plugins.filter(plugin =>
                        plugin instanceof RemoveEmptyScriptsPluginStub).length,
                    expected,
                );
            }
        }
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("valid Sass resources are canonical regular files inside sourceRoot", () => {
    const workspace = makeFixture();
    const firstResource = path.join(workspace.sourceRoot, "shared/_first.scss");
    const secondResource = path.join(workspace.sourceRoot, "shared/_second.scss");

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["shared/_first.scss", "$first: 1;\n"],
            ["shared/_second.scss", "$second: 2;\n"],
        ]);
        const definition = createWebpackBuildDefinition(
            defaultOptions(workspace, {
                sassResourcesByTarget: defaultResourceMap({
                    component: [firstResource, secondResource],
                }),
            }),
            ADAPTERS,
        );
        const componentConfig = definition.configurations.find(configuration =>
            configKey(configuration) === "component/button");
        const resourceLoader = styleRule(componentConfig).use.at(-1);

        assert.equal(resourceLoader.loader, "sass-resources-loader");
        assert.deepEqual(
            resourceLoader.options.resources,
            [fs.realpathSync(firstResource), fs.realpathSync(secondResource)],
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("relative, empty, missing, directory and external Sass resources fail closed", () => {
    const workspace = makeFixture();
    const directory = path.join(workspace.sourceRoot, "shared");
    const missing = path.join(directory, "missing.scss");
    const external = path.join(workspace.workspace, "external.scss");
    const invalidCases = [
        ["relative.scss", /must be a non-empty absolute path/],
        ["", /must be a non-empty absolute path/],
        [missing, /does not exist/],
        [directory, /is not a regular file/],
        [external, /escapes canonical sourceRoot/],
    ];

    try
    {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(external, "$external: true;\n");

        for (const [resource, expectedError] of invalidCases)
        {
            assert.throws(
                () => createWebpackBuildDefinition(
                    defaultOptions(workspace, {
                        sassResourcesByTarget: defaultResourceMap({
                            component: [resource],
                        }),
                    }),
                    ADAPTERS,
                ),
                expectedError,
            );
        }
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("file, ancestor, dangling and external Sass symlinks fail closed", () => {
    const workspace = makeFixture();
    const shared = path.join(workspace.sourceRoot, "shared");
    const actual = path.join(shared, "actual.scss");
    const fileLink = path.join(shared, "file-link.scss");
    const actualDirectory = path.join(shared, "actual-directory");
    const ancestorLink = path.join(shared, "ancestor-link");
    const danglingLink = path.join(shared, "dangling.scss");
    const externalDirectory = path.join(workspace.workspace, "external");
    const externalLink = path.join(shared, "external-link");

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["shared/actual.scss", "$actual: true;\n"],
            ["shared/actual-directory/resource.scss", "$internal: true;\n"],
        ]);
        writeFiles(externalDirectory, [
            ["resource.scss", "$external: true;\n"],
        ]);
        fs.symlinkSync(actual, fileLink, "file");
        fs.symlinkSync(actualDirectory, ancestorLink, "dir");
        fs.symlinkSync(path.join(shared, "absent.scss"), danglingLink, "file");
        fs.symlinkSync(externalDirectory, externalLink, "dir");

        for (const resource of [
            fileLink,
            path.join(ancestorLink, "resource.scss"),
            danglingLink,
            path.join(externalLink, "resource.scss"),
        ])
        {
            assert.throws(
                () => createWebpackBuildDefinition(
                    defaultOptions(workspace, {
                        sassResourcesByTarget: defaultResourceMap({
                            component: [resource],
                        }),
                    }),
                    ADAPTERS,
                ),
                /contains a symlink/,
            );
        }
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("Smart templateCopies are exactly the accepted planner mapping", () => {
    const workspace = makeFixture();

    try
    {
        const definition = createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        assert.equal(definition.templateCopies, definition.plan.templates);
        assert.deepEqual(
            definition.templateCopies.map(template => ({
                destination: path.relative(
                    definition.plan.outputRoot,
                    template.destination,
                ),
                layout: template.layout,
                source: path.relative(
                    definition.plan.sourceRoot,
                    template.source,
                ),
            })),
            [
                {
                    destination: path.join(
                        "smart/card/template",
                        "default.html",
                    ),
                    layout: "template",
                    source: path.join(
                        "smart/card/template",
                        "default.html",
                    ),
                },
                {
                    destination: path.join(
                        "smart/card/template",
                        "interactive.js",
                    ),
                    layout: "js/templates",
                    source: path.join(
                        "smart/card/js/templates",
                        "interactive.js",
                    ),
                },
            ],
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("planner traversal happens once and configuration construction does not re-traverse", () => {
    const workspace = makeFixture();
    const originalReaddirSync = fs.readdirSync;

    try
    {
        let plannerReads = 0;
        fs.readdirSync = function countedPlannerRead(...args)
        {
            plannerReads += 1;

            return originalReaddirSync.apply(this, args);
        };
        createBuildPlan({
            ...workspace,
            targets: DEFAULT_TARGETS,
        });

        let factoryReads = 0;
        fs.readdirSync = function countedFactoryRead(...args)
        {
            factoryReads += 1;

            return originalReaddirSync.apply(this, args);
        };
        createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        assert.equal(factoryReads, plannerReads);
    }
    finally
    {
        fs.readdirSync = originalReaddirSync;
        removeWorkspace(workspace.workspace);
    }
});

test("planner collision, root and source-symlink failures are preserved", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/card/index.js", "module.exports = {};\n"],
        ]);

        assert.throws(
            () => createWebpackBuildDefinition({
                ...workspace,
                configurationPoliciesByTarget: {
                    component: configurationPolicy(),
                },
                sassResourcesByTarget: {
                    component: [],
                },
                targets: [componentTarget(), componentTarget()],
            }, ADAPTERS),
            /duplicate entry key/,
        );
        assert.throws(
            () => createWebpackBuildDefinition(
                componentOptions(workspace, {
                    outputRoot: path.join(workspace.sourceRoot, "output"),
                }),
                ADAPTERS,
            ),
            /must not overlap/,
        );

        fs.rmSync(path.join(workspace.sourceRoot, "component"), {
            force: true,
            recursive: true,
        });
        const external = path.join(workspace.workspace, "external");
        writeFiles(external, [
            ["card/index.js", "module.exports = 'external';\n"],
        ]);
        fs.symlinkSync(
            external,
            path.join(workspace.sourceRoot, "component"),
            "dir",
        );

        assert.throws(
            () => createWebpackBuildDefinition(
                componentOptions(workspace),
                ADAPTERS,
            ),
            /escapes .*root/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("import and calls avoid external resolution, environment reads, writes and logs", () => {
    const workspace = makeFixture();
    const sourceBefore = snapshotTree(workspace.sourceRoot);
    const originalEnv = process.env;
    const originalResolveFilename = Module._resolveFilename;
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
        delete require.cache[FACTORY_PATH];
        delete require.cache[PLAN_PATH];

        Module._resolveFilename = function guardedResolve(request, ...args)
        {
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

        const imported = require(FACTORY_PATH);
        const definition = imported.createWebpackBuildDefinition(
            defaultOptions(workspace),
            ADAPTERS,
        );

        assert.equal(definition.configurations.length, 10);
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

        assert.deepEqual(snapshotTree(workspace.sourceRoot), sourceBefore);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
        removeWorkspace(workspace.workspace);
    }
});

test("factory source has no dotenv, process environment or action side effects", () => {
    const source = factorySource();

    assert.doesNotMatch(source, /dotenv/);
    assert.doesNotMatch(source, /process\.env/);
    assert.doesNotMatch(source, /\b(?:ProvidePlugin|CleanWebpackPlugin)\b/);
    assert.doesNotMatch(
        source,
        /\b(?:publicPath|assetModuleFilename|experiments)\b/,
    );
    assert.doesNotMatch(
        source,
        /\b(?:writeFile|appendFile|copyFile|mkdir|rm|unlink|rename|exec|spawn|fork)\w*Sync\b/,
    );
    assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/);
    assert.doesNotMatch(
        source,
        /\brequire\s*\(\s*["'](?!node:|\.{1,2}\/)[^"']+["']\s*\)/,
    );
});

test("source remains byte-identical and output remains absent after repeated calls", () => {
    const workspace = makeFixture();

    try
    {
        const before = snapshotTree(workspace.sourceRoot);

        createWebpackBuildDefinition(defaultOptions(workspace), ADAPTERS);
        createWebpackBuildDefinition(defaultOptions(workspace), ADAPTERS);

        assert.deepEqual(snapshotTree(workspace.sourceRoot), before);
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});
