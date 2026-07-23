"use strict";

const path = require("node:path");

const {
    StableModuleIdsPlugin,
} = require("./stableModuleIdsPlugin");

function prependUnique(current, first)
{
    const values = Array.isArray(current) ? current : ["node_modules"];

    return [first, ...values.filter(value => value !== first)];
}

function configureProductConfigurations(configurations, roots)
{
    if (!Array.isArray(configurations))
    {
        throw new TypeError("configurations must be an array");
    }

    const {
        builderDependencyRoot,
        builderRoot,
        sourceDependencyRoot,
        sourceRoot,
    } = roots;
    const dependencyModules = path.join(builderDependencyRoot, "node_modules");
    const sourceModules = path.join(sourceDependencyRoot, "node_modules");

    for (const configuration of configurations)
    {
        configuration.optimization = {
            ...(configuration.optimization || {}),
            chunkIds: false,
            moduleIds: false,
        };
        configuration.plugins = [
            ...(Array.isArray(configuration.plugins)
                ? configuration.plugins
                : []),
            new StableModuleIdsPlugin({
                "builder-dependencies": builderDependencyRoot,
                "builder-source": builderRoot,
                "product-dependencies": sourceDependencyRoot,
                "product-source": sourceRoot,
            }),
        ];
        configuration.resolveLoader = {
            ...(configuration.resolveLoader || {}),
            modules: prependUnique(
                configuration.resolveLoader
                    && configuration.resolveLoader.modules,
                dependencyModules,
            ),
        };
        configuration.resolve = {
            ...(configuration.resolve || {}),
            modules: prependUnique(
                configuration.resolve && configuration.resolve.modules,
                sourceModules,
            ),
        };
    }

    return configurations;
}

module.exports = {
    configureProductConfigurations,
};
