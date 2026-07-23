"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
    StableModuleIdsPlugin,
} = require("../../libs/stableModuleIdsPlugin");

function hook()
{
    return {
        handler: null,
        tap(name, handler)
        {
            assert.equal(name, "SfStableModuleIdsPlugin");
            this.handler = handler;
        },
    };
}

function assignedIds(runtimeSuffix)
{
    const compilationHook = hook();
    const compiler = {
        hooks: {
            compilation: compilationHook,
        },
    };
    const moduleIdsHook = hook();
    const chunkIdsHook = hook();
    const ids = new Map();
    const builderDependencyRoot = path.join(
        "/tmp",
        "candidate",
        `builder-runtime-${runtimeSuffix}`,
    );
    const sourceRoot = path.join(
        "/tmp",
        "candidate",
        `source-${runtimeSuffix}`,
    );
    const dependencyRoot = path.join(
        "/tmp",
        "candidate",
        `source-runtime-${runtimeSuffix}`,
    );
    const modules = [
        {
            identifier: () => `${path.join(
                builderDependencyRoot,
                "node_modules/babel-loader/index.js",
            )}!${path.join(
                dependencyRoot,
                "node_modules/example/index.js",
            )}`,
        },
        {
            identifier: () => path.join(sourceRoot, "component", "index.js"),
        },
    ];
    const concatenatedRoot = {
        identifier: () => path.join(sourceRoot, "core", "loader.js"),
    };
    const concatenatedMember = {
        identifier: () => path.join(
            dependencyRoot,
            "node_modules/example/child.js",
        ),
    };

    modules.push({
        _modules: new Set([concatenatedRoot, concatenatedMember]),
        identifier: () => `${concatenatedRoot.identifier()}|${runtimeSuffix
            .repeat(32)
            .slice(0, 32)}`,
        rootModule: concatenatedRoot,
    });
    const compilation = {
        chunkGraph: {
            getModuleId: module => ids.has(module) ? ids.get(module) : null,
            setModuleId: (module, id) => ids.set(module, id),
            getChunkRootModules: chunk => chunk.modules,
        },
        hooks: {
            chunkIds: chunkIdsHook,
            moduleIds: moduleIdsHook,
        },
        chunks: [],
        modules,
    };

    new StableModuleIdsPlugin({
        "builder-dependencies": builderDependencyRoot,
        "product-dependencies": dependencyRoot,
        "product-source": sourceRoot,
    }).apply(compiler);
    compilationHook.handler(compilation);
    moduleIdsHook.handler(modules);

    return modules.map(module => ids.get(module));
}

function assignedChunkIds(runtimeSuffix)
{
    const compilationHook = hook();
    const compiler = { hooks: { compilation: compilationHook } };
    const moduleIdsHook = hook();
    const chunkIdsHook = hook();
    const module = {
        identifier: () => path.join(
            "/tmp",
            `runtime-${runtimeSuffix}`,
            "node_modules/example/index.js",
        ),
    };
    const chunk = {
        id: null,
        idNameHints: new Set(["async"]),
        ids: null,
        modules: [module],
        name: null,
    };
    const moduleIds = new Map();
    const chunkGraph = {
        getChunkRootModules: candidate => candidate.modules,
        getModuleId: candidate => moduleIds.has(candidate)
            ? moduleIds.get(candidate)
            : null,
        setModuleId: (candidate, id) => moduleIds.set(candidate, id),
    };
    const compilation = {
        chunkGraph,
        chunks: [chunk],
        hooks: { chunkIds: chunkIdsHook, moduleIds: moduleIdsHook },
        modules: [module],
    };

    new StableModuleIdsPlugin({
        dependencies: path.join("/tmp", `runtime-${runtimeSuffix}`),
    }).apply(compiler);
    compilationHook.handler(compilation);
    moduleIdsHook.handler([module]);
    chunkIdsHook.handler([chunk]);

    return chunk.id;
}

test("module ids do not depend on disposable runtime root names", () => {
    assert.deepEqual(assignedIds("one"), assignedIds("two"));
});

test("chunk ids derive from stable module ids", () => {
    assert.equal(assignedChunkIds("one"), assignedChunkIds("two"));
});

test("plugin rejects missing, empty and relative roots", () => {
    assert.throws(() => new StableModuleIdsPlugin(), /roots must be an object/);
    assert.throws(() => new StableModuleIdsPlugin({}), /must not be empty/);
    assert.throws(
        () => new StableModuleIdsPlugin({ source: "relative" }),
        /must be an absolute path/,
    );
});
