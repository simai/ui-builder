"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_NAME = "SfStableModuleIdsPlugin";

function canonicalRootEntries(roots)
{
    if (!roots || typeof roots !== "object" || Array.isArray(roots))
    {
        throw new TypeError("roots must be an object");
    }

    const entries = [];
    const seen = new Set();

    for (const [name, root] of Object.entries(roots))
    {
        if (typeof name !== "string" || name.length === 0)
        {
            throw new TypeError("root names must be non-empty strings");
        }

        if (typeof root !== "string" || !path.isAbsolute(root))
        {
            throw new TypeError(`${name} must be an absolute path`);
        }

        const lexical = path.resolve(root);
        const candidates = [lexical];

        try
        {
            candidates.push(fs.realpathSync.native(lexical));
        }
        catch (error)
        {
            if (error.code !== "ENOENT")
            {
                throw error;
            }
        }

        for (const canonical of candidates)
        {
            if (!seen.has(canonical))
            {
                seen.add(canonical);
                entries.push([canonical, `<sf:${name}>`]);
            }
        }
    }

    if (entries.length === 0)
    {
        throw new TypeError("roots must not be empty");
    }

    return entries.sort((left, right) => right[0].length - left[0].length);
}

function stableIdentifier(identifier, roots)
{
    let stable = identifier;

    for (const [root, replacement] of roots)
    {
        stable = stable.split(root).join(replacement);
    }

    return stable;
}

function stableModuleIdentifier(module, roots)
{
    const rootModule = module.rootModule;
    const concatenatedModules = module._modules || module.modules;

    if (rootModule
        && concatenatedModules
        && typeof concatenatedModules[Symbol.iterator] === "function")
    {
        return JSON.stringify({
            kind: "concatenated",
            members: [...concatenatedModules]
                .map(member => stableIdentifier(member.identifier(), roots))
                .sort(),
            root: stableIdentifier(rootModule.identifier(), roots),
        });
    }

    return stableIdentifier(module.identifier(), roots);
}

function digest(identifier, length)
{
    return crypto.createHash("sha256")
        .update(identifier)
        .digest("hex")
        .slice(0, length);
}

function stableChunkKey(chunk, chunkGraph)
{
    if (chunk.name)
    {
        return `name:${chunk.name}`;
    }

    const moduleIds = chunkGraph.getChunkRootModules(chunk)
        .map(module => chunkGraph.getModuleId(module))
        .map(String)
        .sort();
    const hints = [...chunk.idNameHints].map(String).sort();

    return JSON.stringify({ hints, moduleIds });
}

class StableModuleIdsPlugin
{
    constructor(roots)
    {
        this.roots = canonicalRootEntries(roots);
    }

    apply(compiler)
    {
        compiler.hooks.compilation.tap(PLUGIN_NAME, compilation => {
            compilation.hooks.moduleIds.tap(PLUGIN_NAME, modules => {
                const chunkGraph = compilation.chunkGraph;
                const candidates = [...modules]
                    .filter(module => chunkGraph.getModuleId(module) === null)
                    .map(module => ({
                        identifier: stableModuleIdentifier(module, this.roots),
                        module,
                    }))
                    .sort((left, right) => {
                        if (left.identifier < right.identifier)
                        {
                            return -1;
                        }

                        if (left.identifier > right.identifier)
                        {
                            return 1;
                        }

                        return 0;
                    });
                const used = new Set(
                    [...compilation.modules]
                        .map(module => chunkGraph.getModuleId(module))
                        .filter(identifier => identifier !== null)
                        .map(String),
                );

                for (const candidate of candidates)
                {
                    let length = 12;
                    let identifier = digest(candidate.identifier, length);

                    while (used.has(identifier))
                    {
                        length += 2;

                        if (length > 64)
                        {
                            throw new Error(
                                "stable module identifier collision: "
                                + candidate.identifier,
                            );
                        }

                        identifier = digest(candidate.identifier, length);
                    }

                    used.add(identifier);
                    chunkGraph.setModuleId(candidate.module, identifier);
                }
            });
            compilation.hooks.chunkIds.tap(PLUGIN_NAME, chunks => {
                const chunkGraph = compilation.chunkGraph;
                const candidates = [...chunks]
                    .filter(chunk => chunk.id === null)
                    .map(chunk => ({
                        chunk,
                        identifier: stableChunkKey(chunk, chunkGraph),
                    }))
                    .sort((left, right) => {
                        if (left.identifier < right.identifier)
                        {
                            return -1;
                        }

                        if (left.identifier > right.identifier)
                        {
                            return 1;
                        }

                        return 0;
                    });
                const used = new Set(
                    [...compilation.chunks]
                        .flatMap(chunk => chunk.ids || [])
                        .map(String),
                );

                for (const candidate of candidates)
                {
                    let attempt = 0;
                    let identifier;

                    do
                    {
                        identifier = String(parseInt(digest(
                            `${candidate.identifier}\0${attempt}`,
                            12,
                        ), 16));
                        attempt += 1;
                    }
                    while (used.has(identifier));

                    used.add(identifier);
                    candidate.chunk.id = Number(identifier);
                    candidate.chunk.ids = [Number(identifier)];
                }
            });
        });
    }
}

module.exports = {
    StableModuleIdsPlugin,
};
