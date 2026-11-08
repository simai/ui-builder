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
const { coreEntryKey, coreModuleFile, coreModuleFor } = require("./packageCore");

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
    // The element layer (stand 25, 2026-10-28): one instance per page.
    "element-manifest": "core/js/element-manifest",
    "aliases": "core/js/aliases",
    "alias-table": "core/js/alias-table",
    "host-port": "core/js/host-port",
    "deprecations": "core/js/deprecations",
    "page-actions": "core/js/page-actions",
    "layer-stack": "core/js/layer-stack",
    "open-surface-mark": "core/js/open-surface-mark",
    "instance-path": "core/js/instance-path",
});

function withoutExtension(file)
{
    return file.replace(/\.(m?js)$/u, "");
}

// The runtime's contract in the source being built
// (core/contracts/shared-runtime.v1.json, ui-source 2026-10-28): the ABI a
// bundle asks with, the modules Core publishes for the runtime to take. A
// source from before it has none: its bundles ask without an ABI and its
// runtime carries its own copies, as before.
const contractCache = new Map();
function readRuntimeContract(sourceRoot)
{
    const file = path.join(sourceRoot, "core/contracts/shared-runtime.v1.json");
    if (!contractCache.has(file))
    {
        let contract = null;
        if (fs.existsSync(file))
        {
            contract = JSON.parse(fs.readFileSync(file, "utf8"));
            if (contract.schema !== "simai.framework.shared-runtime" || !Number.isInteger(contract.abi))
            {
                throw new Error(`${file} is not a simai.framework.shared-runtime contract`);
            }
        }
        contractCache.set(file, contract);
    }
    return contractCache.get(file);
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

// The ids the source's own runtime hands out (core/js/runtime.js, the keys of
// RUNTIME_MODULES). A package is built over the ui-source of the release it
// pins, and runs on that release's runtime: an id this builder knows but that
// runtime lacks (element-manifest before 2026-10-28) stays bundled, or the
// package would ask the page for a module it does not have. A source without
// a runtime.js (or a test's imaginary root) gets every id, as before.
const runtimeIdCache = new Map();
function runtimeIdsOf(sourceRoot)
{
    const file = path.join(sourceRoot, "core/js/runtime.js");
    if (!runtimeIdCache.has(file))
    {
        runtimeIdCache.set(file, fs.existsSync(file)
            ? new Set([...fs.readFileSync(file, "utf8").matchAll(/^\s+"([^"]+)": asModule\(/gmu)].map((match) => match[1]))
            : null);
    }
    return runtimeIdCache.get(file);
}

function runtimeIdFor(request, sourceRoot)
{
    const id = anyRuntimeIdFor(request, sourceRoot);
    const offered = id && runtimeIdsOf(path.resolve(sourceRoot));
    return id && (!offered || offered.has(id)) ? id : null;
}

function anyRuntimeIdFor({ context, request, issuer }, sourceRoot)
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
    const base = path.join(sourceRoot, relative);
    const file = [base, `${base}.js`, `${base}.mjs`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    return file ? exportsOfFile(file) : null;
}

// The names a module file exports; null when it re-exports a whole module.
function exportsOfFile(file)
{
    const key = file;
    if (exportCache.has(key)) return exportCache.get(key);
    const acorn = require("acorn");
    const program = acorn.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
    let names = new Set();
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
    constructor(sourceRoot, usage = null, packageCore = null)
    {
        this.sourceRoot = sourceRoot;
        // A package's shared core (libs/packageCore.js): its ids are checked
        // against the core folder's own files and reported apart from the
        // runtime's, which a receipt compares with the release.
        this.packageCore = packageCore;
        // id -> Set of the names the build's bundles import from it ("*" for a
        // namespace or side-effect import): what a package receipt records.
        this.usage = usage;
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
                        const target = compilation.moduleGraph.getModule(dependency);
                        const match = typeof target?.request === "string" && target.request.match(/runtimeModule\("([^"]+)"/u);
                        if (!match) continue;
                        const core = this.packageCore;
                        const coreName = core && match[1].startsWith(`${core.name}/`) ? match[1].slice(core.name.length + 1) : null;
                        const usage = coreName === null ? this.usage : core.usage;
                        if (usage)
                        {
                            if (!usage[match[1]]) usage[match[1]] = new Set();
                            const ids = Array.isArray(dependency.ids) && dependency.ids.length ? dependency.ids : null;
                            if (ids) usage[match[1]].add(ids[0]);
                            else if (dependency.type !== "harmony side effect evaluation") usage[match[1]].add("*");
                        }
                        if (!Array.isArray(dependency.ids) || !dependency.ids.length) continue;
                        let names;
                        if (coreName !== null)
                        {
                            const file = coreModuleFile(this.sourceRoot, core, coreName);
                            names = file ? exportsOfFile(file) : new Set();
                        }
                        else
                        {
                            if (!CORE_MODULES[match[1]]) continue;
                            names = runtimeExports(match[1], this.sourceRoot);
                        }
                        const name = dependency.ids[0];
                        if (!names || names.has(name)) continue;
                        const error = new WebpackError(
                            `${module.resource || module.identifier()} imports "${name}" from the ${coreName === null ? "runtime" : "package core"} module "${match[1]}", which does not export it`,
                        );
                        error.module = module;
                        compilation.errors.push(error);
                    }
                }
            });
        });
    }
}

// `packageCore` ({name, folder, abi, users?, usage?}): the package's shared
// core (libs/packageCore.js). Its own bundle (entry smart/<folder>) keeps its
// modules; in every other bundle an import from the folder becomes
// `SF.runtimeModule("<name>/<module>", <abi>)`, and the bundle's folder is
// added to `users`.
function applySharedRuntimeExternals(configurations, { sourceRoot, usage = null, packageCore = null })
{
    if (!Array.isArray(configurations))
    {
        throw new TypeError("configurations must be an array");
    }
    const root = path.resolve(sourceRoot);
    const contract = readRuntimeContract(root);
    // The bundle asks with the ABI of the source it was built from; the page's
    // runtime refuses another (ui-source core/js/runtime.js checkRuntimeAbi).
    const abi = contract ? `, ${contract.abi}` : "";

    for (const configuration of configurations)
    {
        configuration.externalsType = "promise";
        // A name imported from a bundled module that the module does not export
        // is an error, not a warning that leaves an undefined in the bundle.
        configuration.module = configuration.module || {};
        configuration.module.parser = configuration.module.parser || {};
        configuration.module.parser.javascript = { ...(configuration.module.parser.javascript || {}), exportsPresence: "error" };
        configuration.plugins = [...(configuration.plugins || []), new RuntimeExportsCheck(root, usage, packageCore)];
        const entryKey = Object.keys(configuration.entry || {})[0] || "";
        const ownCore = packageCore && entryKey === coreEntryKey(packageCore);
        configuration.externals = [
            ({ context, request, contextInfo }, callback) => {
                const issuer = contextInfo && contextInfo.issuer;
                const id = runtimeIdFor({ context, request, issuer }, root);
                if (id)
                {
                    callback(null, runtimeExternal(id, abi));
                    return;
                }
                const coreName = packageCore && !ownCore ? coreModuleFor({ context, request, issuer }, root, packageCore) : null;
                if (coreName === null)
                {
                    callback();
                    return;
                }
                if (entryKey.startsWith("smart/"))
                {
                    const folder = entryKey.slice("smart/".length);
                    if (packageCore.users) packageCore.users.add(folder);
                    // Which components import each module directly: a module one
                    // component alone takes is better kept in that component.
                    if (packageCore.moduleUsers)
                    {
                        const id = `${packageCore.name}/${coreName}`;
                        (packageCore.moduleUsers[id] = packageCore.moduleUsers[id] || new Set()).add(folder);
                    }
                }
                callback(null, runtimeExternal(`${packageCore.name}/${coreName}`, `, ${packageCore.abi}`));
            },
        ];
    }

    return configurations;
}

// Core's lookup when Core is on the page; otherwise the runtime script's, once
// it has run (a page that includes it by hand).
function runtimeExternal(id, abi)
{
    const key = JSON.stringify(id);
    return `(globalThis.SF && globalThis.SF.runtimeModule ? globalThis.SF.runtimeModule(${key}${abi}) : new Promise((resolve, reject) => globalThis.addEventListener("sf-runtime-ready", () => globalThis.SF.runtimeModule(${key}${abi}).then(resolve, reject), { once: true })))`;
}

// The names each runtime module is asked for, sorted, for a receipt.
function runtimeUsageReport(usage, sourceRoot)
{
    const contract = readRuntimeContract(path.resolve(sourceRoot));
    return {
        schema: "simai.framework.shared-runtime-usage",
        version: 1,
        abi: contract ? contract.abi : null,
        modules: Object.fromEntries(Object.keys(usage || {}).sort().map((id) => [id, [...usage[id]].sort()])),
    };
}

module.exports = {
    BARE_MODULES,
    CORE_MODULES,
    RuntimeExportsCheck,
    applySharedRuntimeExternals,
    readRuntimeContract,
    runtimeUsageReport,
    runtimeExports,
    runtimeIdFor,
};
