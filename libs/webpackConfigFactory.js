"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
    createBuildPlan,
} = require("./buildPlan");
const {
    assertRtlSafePostcssPlugins,
} = require("./postcssPolicy");

function isWithin(root, candidate)
{
    const relative = path.relative(root, candidate);

    return relative === ""
        || (!relative.startsWith(`..${path.sep}`)
            && relative !== ".."
            && !path.isAbsolute(relative));
}

function assertTargets(targets)
{
    if (!Array.isArray(targets) || targets.length === 0)
    {
        throw new TypeError("targets must be a non-empty array");
    }
}

function ownEnumerableDataValues(value, expectedKeys, label)
{
    if (!value
        || typeof value !== "object"
        || Array.isArray(value))
    {
        throw new TypeError(`${label} must be an object`);
    }

    const ownKeys = Reflect.ownKeys(value);

    if (ownKeys.some(key => typeof key !== "string")
        || ownKeys.length !== expectedKeys.length
        || expectedKeys.some(key => !ownKeys.includes(key)))
    {
        throw new TypeError(
            `${label} must contain exactly: ${expectedKeys.join(", ")}`,
        );
    }

    const values = Object.create(null);

    for (const key of expectedKeys)
    {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor
            || !descriptor.enumerable
            || !Object.prototype.hasOwnProperty.call(descriptor, "value"))
        {
            throw new TypeError(
                `${label}.${key} must be an own enumerable data property`,
            );
        }

        values[key] = descriptor.value;
    }

    return values;
}

function cloneJsonLike(value, label, ancestors = new WeakSet())
{
    if (value === null
        || typeof value === "boolean"
        || typeof value === "string")
    {
        return value;
    }

    if (typeof value === "number")
    {
        if (!Number.isFinite(value))
        {
            throw new TypeError(`${label} must contain only finite numbers`);
        }

        return value;
    }

    if (!value || typeof value !== "object")
    {
        throw new TypeError(`${label} must contain only JSON-like data`);
    }

    if (ancestors.has(value))
    {
        throw new TypeError(`${label} must not contain cycles`);
    }

    ancestors.add(value);

    try
    {
        if (Array.isArray(value))
        {
            if (Object.getPrototypeOf(value) !== Array.prototype)
            {
                throw new TypeError(`${label} must contain only plain arrays`);
            }

            const ownKeys = Reflect.ownKeys(value);

            if (ownKeys.some(key => typeof key !== "string")
                || !ownKeys.includes("length")
                || ownKeys.length !== value.length + 1)
            {
                throw new TypeError(
                    `${label} must not contain sparse or extended arrays`,
                );
            }

            const clone = [];

            for (let index = 0; index < value.length; index += 1)
            {
                const descriptor = Object.getOwnPropertyDescriptor(
                    value,
                    String(index),
                );

                if (!descriptor
                    || !descriptor.enumerable
                    || !Object.prototype.hasOwnProperty.call(
                        descriptor,
                        "value",
                    ))
                {
                    throw new TypeError(
                        `${label}[${index}] must be an own enumerable data property`,
                    );
                }

                clone.push(cloneJsonLike(
                    descriptor.value,
                    `${label}[${index}]`,
                    ancestors,
                ));
            }

            return clone;
        }

        if (Object.getPrototypeOf(value) !== Object.prototype)
        {
            throw new TypeError(`${label} must contain only plain objects`);
        }

        const clone = {};

        for (const key of Reflect.ownKeys(value))
        {
            if (typeof key !== "string")
            {
                throw new TypeError(`${label} must not contain symbol keys`);
            }

            if (["__proto__", "prototype", "constructor"].includes(key))
            {
                throw new TypeError(
                    `${label} must not contain dangerous key: ${key}`,
                );
            }

            const descriptor = Object.getOwnPropertyDescriptor(value, key);

            if (!descriptor
                || !descriptor.enumerable
                || !Object.prototype.hasOwnProperty.call(descriptor, "value"))
            {
                throw new TypeError(
                    `${label}.${key} must be an own enumerable data property`,
                );
            }

            clone[key] = cloneJsonLike(
                descriptor.value,
                `${label}.${key}`,
                ancestors,
            );
        }

        return clone;
    }
    finally
    {
        ancestors.delete(value);
    }
}

function validateConfigurationPolicy(policy, label)
{
    const values = ownEnumerableDataValues(
        policy,
        ["devtool", "postcss", "resolveExtensions", "target", "output"],
        label,
    );
    const postcss = ownEnumerableDataValues(
        values.postcss,
        ["plugins"],
        `${label}.postcss`,
    );
    const output = ownEnumerableDataValues(
        values.output,
        ["pathinfo"],
        `${label}.output`,
    );
    const plugins = cloneJsonLike(
        postcss.plugins,
        `${label}.postcss.plugins`,
    );
    const resolveExtensions = cloneJsonLike(
        values.resolveExtensions,
        `${label}.resolveExtensions`,
    );

    if (values.devtool !== false)
    {
        throw new TypeError(`${label}.devtool must be false`);
    }

    if (output.pathinfo !== false)
    {
        throw new TypeError(`${label}.output.pathinfo must be false`);
    }

    if (typeof values.target !== "string" || values.target.length === 0)
    {
        throw new TypeError(`${label}.target must be a non-empty string`);
    }

    if (!Array.isArray(resolveExtensions)
        || resolveExtensions.length === 0
        || resolveExtensions.some(extension =>
            typeof extension !== "string"
            || extension.length === 0
            || !extension.startsWith("."))
        || new Set(resolveExtensions).size !== resolveExtensions.length)
    {
        throw new TypeError(
            `${label}.resolveExtensions must be a non-empty unique array of dot-prefixed strings`,
        );
    }

    if (!Array.isArray(plugins))
    {
        throw new TypeError(`${label}.postcss.plugins must be an array`);
    }

    assertRtlSafePostcssPlugins(
        plugins,
        `${label}.postcss.plugins`,
    );

    for (const [pluginIndex, plugin] of plugins.entries())
    {
        if (!Array.isArray(plugin)
            || plugin.length !== 2
            || typeof plugin[0] !== "string"
            || plugin[0].length === 0)
        {
            throw new TypeError(
                `${label}.postcss.plugins[${pluginIndex}] must be exactly [non-empty string, JSON-like options]`,
            );
        }
    }

    return {
        devtool: false,
        output: {
            pathinfo: false,
        },
        postcss: {
            plugins,
        },
        resolveExtensions,
        target: values.target,
    };
}

function validateConfigurationPolicies(targets, policies)
{
    const targetNames = [];

    for (const [targetIndex, target] of targets.entries())
    {
        if (!target
            || typeof target !== "object"
            || typeof target.name !== "string"
            || target.name.length === 0)
        {
            throw new TypeError(
                `targets[${targetIndex}].name must be a non-empty string`,
            );
        }

        if (!targetNames.includes(target.name))
        {
            targetNames.push(target.name);
        }
    }

    const values = ownEnumerableDataValues(
        policies,
        targetNames,
        "configurationPoliciesByTarget",
    );
    const validated = Object.create(null);

    for (const targetName of targetNames)
    {
        validated[targetName] = validateConfigurationPolicy(
            values[targetName],
            `configurationPoliciesByTarget.${targetName}`,
        );
    }

    return validated;
}

function assertAdapters(adapters)
{
    if (!adapters || typeof adapters !== "object")
    {
        throw new TypeError("adapters must be an object");
    }

    for (const name of [
        "MiniCssExtractPlugin",
        "RemoveEmptyScriptsPlugin",
        "TerserPlugin",
    ])
    {
        if (typeof adapters[name] !== "function")
        {
            throw new TypeError(`adapters.${name} must be a constructor`);
        }
    }

    if (typeof adapters.MiniCssExtractPlugin.loader !== "string"
        || adapters.MiniCssExtractPlugin.loader.length === 0)
    {
        throw new TypeError(
            "adapters.MiniCssExtractPlugin.loader must be a non-empty string",
        );
    }
}

function assertResourceMap(targets, sassResourcesByTarget)
{
    if (!sassResourcesByTarget
        || typeof sassResourcesByTarget !== "object"
        || Array.isArray(sassResourcesByTarget))
    {
        throw new TypeError("sassResourcesByTarget must be an object");
    }

    for (const target of targets)
    {
        if (!target || typeof target !== "object")
        {
            continue;
        }

        const targetName = target.name;

        if (typeof targetName !== "string" || targetName.length === 0)
        {
            continue;
        }

        if (!Object.prototype.hasOwnProperty.call(
            sassResourcesByTarget,
            targetName,
        ))
        {
            throw new TypeError(
                `sassResourcesByTarget.${targetName} must be an explicit array`,
            );
        }

        if (!Array.isArray(sassResourcesByTarget[targetName]))
        {
            throw new TypeError(
                `sassResourcesByTarget.${targetName} must be an explicit array`,
            );
        }

    }
}

function validateResource(resource, declaredSourceRoot, sourceRoot, label)
{
    if (typeof resource !== "string"
        || resource.length === 0
        || !path.isAbsolute(resource))
    {
        throw new TypeError(`${label} must be a non-empty absolute path`);
    }

    const normalizedResource = path.normalize(resource);
    const normalizedDeclaredRoot = path.normalize(declaredSourceRoot);
    let lexicalRoot;

    if (isWithin(normalizedDeclaredRoot, normalizedResource)
        && normalizedResource !== normalizedDeclaredRoot)
    {
        lexicalRoot = normalizedDeclaredRoot;
    }
    else if (isWithin(sourceRoot, normalizedResource)
        && normalizedResource !== sourceRoot)
    {
        lexicalRoot = sourceRoot;
    }
    else
    {
        throw new Error(`${label} escapes canonical sourceRoot: ${resource}`);
    }

    const relative = path.relative(lexicalRoot, normalizedResource);
    const segments = relative.split(path.sep).filter(Boolean);
    let cursor = lexicalRoot;

    for (const [index, segment] of segments.entries())
    {
        cursor = path.join(cursor, segment);

        let stat;

        try
        {
            stat = fs.lstatSync(cursor);
        }
        catch
        {
            throw new Error(`${label} does not exist: ${resource}`);
        }

        if (stat.isSymbolicLink())
        {
            throw new Error(`${label} contains a symlink: ${cursor}`);
        }

        const isFinal = index === segments.length - 1;

        if (!isFinal && !stat.isDirectory())
        {
            throw new Error(`${label} ancestor is not a directory: ${cursor}`);
        }

        if (isFinal && !stat.isFile())
        {
            throw new Error(`${label} is not a regular file: ${resource}`);
        }
    }

    let canonicalResource;

    try
    {
        canonicalResource = fs.realpathSync(normalizedResource);
    }
    catch
    {
        throw new Error(`${label} cannot be resolved: ${resource}`);
    }

    if (!isWithin(sourceRoot, canonicalResource)
        || canonicalResource === sourceRoot)
    {
        throw new Error(`${label} escapes canonical sourceRoot: ${resource}`);
    }

    if (!fs.statSync(canonicalResource).isFile())
    {
        throw new Error(`${label} is not a regular file: ${resource}`);
    }

    return canonicalResource;
}

function validateResources(
    targets,
    sassResourcesByTarget,
    declaredSourceRoot,
    sourceRoot,
)
{
    const validated = Object.create(null);

    for (const target of targets)
    {
        const resources = sassResourcesByTarget[target.name];

        validated[target.name] = resources.map((resource, resourceIndex) =>
            validateResource(
                resource,
                declaredSourceRoot,
                sourceRoot,
                `sassResourcesByTarget.${target.name}[${resourceIndex}]`,
            ));
    }

    return validated;
}

function entryLeaf(key)
{
    const segments = key.split("/");

    return segments[segments.length - 1];
}

function cloneConfigurationPolicy(policy)
{
    return {
        devtool: policy.devtool,
        output: {
            pathinfo: policy.output.pathinfo,
        },
        postcss: {
            plugins: cloneJsonLike(
                policy.postcss.plugins,
                "validated configuration policy plugins",
            ),
        },
        resolveExtensions: [...policy.resolveExtensions],
        target: policy.target,
    };
}

function createStyleRule(MiniCssExtractPlugin, resources, policy)
{
    const use = [
        {
            loader: MiniCssExtractPlugin.loader,
        },
        "css-loader",
        {
            loader: "postcss-loader",
            options: {
                postcssOptions: {
                    plugins: policy.postcss.plugins,
                },
            },
        },
        "sass-loader",
    ];

    if (resources.length > 0)
    {
        use.push({
            loader: "sass-resources-loader",
            options: {
                resources: [...resources],
            },
        });
    }

    return {
        test: /\.(scss|css)$/,
        use,
    };
}

function createConfiguration(
    entry,
    resources,
    adapters,
    policy,
    sourceRoot,
    minified,
)
{
    const {
        MiniCssExtractPlugin,
        RemoveEmptyScriptsPlugin,
        TerserPlugin,
    } = adapters;
    const configurationPolicy = cloneConfigurationPolicy(policy);
    const leaf = entryLeaf(entry.key);
    const suffix = minified ? ".min" : "";
    const plugins = [
        new MiniCssExtractPlugin({
            filename: `css/${leaf}${suffix}.css`,
        }),
    ];

    if (path.extname(entry.input).toLowerCase() === ".scss")
    {
        plugins.push(new RemoveEmptyScriptsPlugin());
    }

    return {
        cache: false,
        context: sourceRoot,
        devtool: configurationPolicy.devtool,
        entry: {
            [entry.key]: entry.input,
        },
        // Both distributable variants must resolve dependency conditionals as
        // production code. The raw variant remains readable because its
        // optimization block explicitly disables minification below.
        mode: "production",
        module: {
            rules: [
                {
                    exclude: /node_modules/,
                    test: /\.js$/,
                    use: ["babel-loader"],
                },
                createStyleRule(
                    MiniCssExtractPlugin,
                    resources,
                    configurationPolicy,
                ),
            ],
        },
        optimization: minified
            ? {
                chunkIds: "deterministic",
                minimize: true,
                minimizer: [
                    new TerserPlugin(),
                ],
                moduleIds: "deterministic",
            }
            : {
                chunkIds: "deterministic",
                minimize: false,
                moduleIds: "deterministic",
            },
        output: {
            chunkFilename: minified
                ? "js/[name].min.js"
                : "js/[name].js",
            filename: `js/${leaf}${suffix}.js`,
            path: entry.outputDirectory,
            pathinfo: configurationPolicy.output.pathinfo,
        },
        plugins,
        resolve: {
            extensions: configurationPolicy.resolveExtensions,
        },
        target: configurationPolicy.target,
        watch: false,
    };
}

function createWebpackBuildDefinition(options, adapters)
{
    if (!options || typeof options !== "object")
    {
        throw new TypeError("options must be an object");
    }

    assertTargets(options.targets);
    const configurationPoliciesByTarget = validateConfigurationPolicies(
        options.targets,
        options.configurationPoliciesByTarget,
    );
    assertAdapters(adapters);
    assertResourceMap(options.targets, options.sassResourcesByTarget);

    const plan = createBuildPlan({
        outputRoot: options.outputRoot,
        sourceRoot: options.sourceRoot,
        targets: options.targets,
    });
    const resourcesByTarget = validateResources(
        options.targets,
        options.sassResourcesByTarget,
        options.sourceRoot,
        plan.sourceRoot,
    );
    const configurations = [];

    for (const entry of plan.entries)
    {
        const policy = configurationPoliciesByTarget[entry.target];
        const resources = resourcesByTarget[entry.target];

        configurations.push(
            createConfiguration(
                entry,
                resources,
                adapters,
                policy,
                plan.sourceRoot,
                false,
            ),
            createConfiguration(
                entry,
                resources,
                adapters,
                policy,
                plan.sourceRoot,
                true,
            ),
        );
    }

    return {
        configurations,
        plan,
        templateCopies: plan.templates,
    };
}

module.exports = {
    createWebpackBuildDefinition,
};
