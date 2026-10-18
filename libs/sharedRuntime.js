"use strict";

// The shared Smart runtime (ui-source src/core/js/runtime.js): the modules every
// Smart element is built on are loaded once per page by Core, and the Smart and
// package bundles are built without their own copies (2026-10-13). Each Smart
// bundle carried lit, smart-base and page-language itself -- about 50 KB
// minified, parsed again for every element on the page.
//
// An import of one of these modules from a product source file becomes an
// external that waits for the runtime: `SF.runtimeModule(id)`. The ids are the
// runtime's keys; keep the two lists the same.

const fs = require("node:fs");
const path = require("node:path");

const BARE_MODULES = Object.freeze([
    "lit",
    "lit/directive.js",
    "lit/directive-helpers.js",
    "lit/directives/ref.js",
    "lit/directives/keyed.js",
    "lit/directives/unsafe-html.js",
    "lit/directives/repeat.js",
]);

const CORE_MODULES = Object.freeze({
    "smart-base": "core/js/smart-base",
    "page-language": "core/js/page-language",
    "position": "core/js/position",
    "control-spacing": "core/js/control-spacing",
});

function withoutExtension(file)
{
    return file.replace(/\.(m?js)$/u, "");
}

const realDirectories = new Map();
function realDirectory(directory)
{
    if (!realDirectories.has(directory))
    {
        let real = directory;
        try
        {
            real = fs.realpathSync(directory);
        }
        catch
        {
            real = directory;
        }
        realDirectories.set(directory, real);
    }
    return realDirectories.get(directory);
}

function runtimeIdFor({ context, request, issuer }, sourceRoot)
{
    if (!request || (issuer && issuer.includes(`${path.sep}node_modules${path.sep}`)))
    {
        return null;
    }
    if (BARE_MODULES.includes(request))
    {
        return request;
    }
    if (!request.startsWith(".") || !context)
    {
        return null;
    }
    // Both sides through realpath: a workspace under a symlinked directory --
    // macOS's /var/folders is /private/var/folders -- gave the importer's
    // real path and the source root's linked one, nothing matched, and every
    // package file bundled its own lit and smart-base instead of using the
    // shared runtime, with a receipt that still said it agreed (docs trial 4,
    // 2026-10-15).
    const target = withoutExtension(path.resolve(realDirectory(context), request));
    const root = realDirectory(sourceRoot);
    for (const [id, relative] of Object.entries(CORE_MODULES))
    {
        if (target === path.join(root, relative))
        {
            return id;
        }
    }

    return null;
}

// The names a Core runtime module exports, read from its source; null when it
// re-exports a whole module (export *) and the list cannot be read off the file.
const exportCache = new Map();
function runtimeExports(id, sourceRoot)
{
    const relative = CORE_MODULES[id];
    if (!relative) return null;
    const key = `${sourceRoot}\0${id}`;
    if (exportCache.has(key)) return exportCache.get(key);
    const base = path.join(sourceRoot, relative);
    const file = [base, `${base}.js`, `${base}.mjs`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    let names = null;
    if (file)
    {
        const acorn = require("acorn");
        const program = acorn.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
        names = new Set();
        for (const node of program.body)
        {
            if (node.type === "ExportAllDeclaration")
            {
                if (!node.exported) { names = null; break; }
                names.add(node.exported.name ?? node.exported.value);
            }
            else if (node.type === "ExportDefaultDeclaration") names.add("default");
            else if (node.type === "ExportNamedDeclaration")
            {
                const declaration = node.declaration;
                if (declaration?.id) names.add(declaration.id.name);
                for (const item of declaration?.declarations || []) if (item.id.type === "Identifier") names.add(item.id.name);
                for (const specifier of node.specifiers || []) names.add(specifier.exported.name ?? specifier.exported.value);
            }
        }
    }
    exportCache.set(key, names);
    return names;
}

// A named import from a runtime module is resolved in the browser, off the
// namespace Core hands over: a name the module does not export was undefined at
// run time and no build said so -- webpack cannot see into an external. This
// reads each import of a Core runtime module against the module's own exports
// and fails the build on a name it lacks.
class RuntimeExportsCheck
{
    constructor(sourceRoot)
    {
        this.sourceRoot = sourceRoot;
    }

    apply(compiler)
    {
        const { WebpackError } = compiler.webpack;
        compiler.hooks.compilation.tap("SfRuntimeExportsCheck", (compilation) => {
            compilation.hooks.finishModules.tap("SfRuntimeExportsCheck", (modules) => {
                for (const module of modules)
                {
                    for (const dependency of module.dependencies || [])
                    {
                        if (!Array.isArray(dependency.ids) || !dependency.ids.length) continue;
                        const target = compilation.moduleGraph.getModule(dependency);
                        const match = typeof target?.request === "string" && target.request.match(/runtimeModule\("([^"]+)"\)/u);
                        if (!match || !CORE_MODULES[match[1]]) continue;
                        const names = runtimeExports(match[1], this.sourceRoot);
                        const name = dependency.ids[0];
                        if (!names || names.has(name)) continue;
                        const error = new WebpackError(
                            `${module.resource || module.identifier()} imports "${name}" from the runtime module "${match[1]}", which does not export it`,
                        );
                        error.module = module;
                        compilation.errors.push(error);
                    }
                }
            });
        });
    }
}

function applySharedRuntimeExternals(configurations, { sourceRoot })
{
    if (!Array.isArray(configurations))
    {
        throw new TypeError("configurations must be an array");
    }
    const root = path.resolve(sourceRoot);

    for (const configuration of configurations)
    {
        configuration.externalsType = "promise";
        // A name imported from a bundled module that the module does not export
        // is an error, not a warning that leaves an undefined in the bundle.
        configuration.module = configuration.module || {};
        configuration.module.parser = configuration.module.parser || {};
        configuration.module.parser.javascript = { ...(configuration.module.parser.javascript || {}), exportsPresence: "error" };
        configuration.plugins = [...(configuration.plugins || []), new RuntimeExportsCheck(root)];
        configuration.externals = [
            ({ context, request, contextInfo }, callback) => {
                const id = runtimeIdFor({ context, request, issuer: contextInfo && contextInfo.issuer }, root);
                if (!id)
                {
                    callback();
                    return;
                }
                // Core's lookup when Core is on the page; otherwise the runtime
                // script's, once it has run (a page that includes it by hand).
                const key = JSON.stringify(id);
                callback(null, `(globalThis.SF && globalThis.SF.runtimeModule ? globalThis.SF.runtimeModule(${key}) : new Promise((resolve) => globalThis.addEventListener("sf-runtime-ready", () => resolve(globalThis.SF.runtimeModule(${key})), { once: true })))`);
            },
        ];
    }

    return configurations;
}

module.exports = {
    BARE_MODULES,
    CORE_MODULES,
    RuntimeExportsCheck,
    applySharedRuntimeExternals,
    runtimeExports,
    runtimeIdFor,
};
