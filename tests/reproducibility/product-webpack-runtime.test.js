"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
    configureProductConfigurations,
} = require("../../libs/productWebpackRuntime");
const {
    StableModuleIdsPlugin,
} = require("../../libs/stableModuleIdsPlugin");

test("all product configurations receive stable ids and frozen runtime roots", () => {
    const configurations = [{
        optimization: { minimize: false, moduleIds: "deterministic" },
        plugins: [{ name: "existing" }],
        resolve: { extensions: [".js"], modules: ["custom-source"] },
        resolveLoader: { modules: ["custom-loader"] },
    }, {
        resolve: { extensions: [".scss"] },
    }];
    const roots = {
        builderDependencyRoot: "/tmp/builder-runtime",
        builderRoot: "/tmp/builder-source",
        sourceDependencyRoot: "/tmp/source-runtime",
        sourceRoot: "/tmp/source-product",
    };

    assert.equal(
        configureProductConfigurations(configurations, roots),
        configurations,
    );

    for (const configuration of configurations)
    {
        assert.equal(configuration.optimization.chunkIds, false);
        assert.equal(configuration.optimization.moduleIds, false);
        assert.ok(configuration.plugins.at(-1) instanceof StableModuleIdsPlugin);
        assert.equal(
            configuration.resolveLoader.modules[0],
            path.join(roots.builderDependencyRoot, "node_modules"),
        );
        assert.equal(
            configuration.resolve.modules[0],
            path.join(roots.sourceDependencyRoot, "node_modules"),
        );
    }

    assert.equal(configurations[0].optimization.minimize, false);
    assert.deepEqual(configurations[0].resolve.extensions, [".js"]);
    assert.deepEqual(configurations[0].resolveLoader.modules.slice(1), [
        "custom-loader",
    ]);
    assert.deepEqual(configurations[0].resolve.modules.slice(1), [
        "custom-source",
    ]);
});

test("runtime configuration rejects a non-array definition", () => {
    assert.throws(
        () => configureProductConfigurations(null, {}),
        /configurations must be an array/,
    );
});
