"use strict";

// A package's shared core (ui-source core.runtime 1.38.0, "Package modules"
// in docs/developer/shared-runtime.md). Code every component of a package
// draws with -- a chart set's scales, formats and data readers -- lives in a
// helper folder of the package (src/smart/<folder>, no rule.js). Bundled the
// ordinary way, every component carries its own copy of what it imports from
// there. Declared as the package's core (package.json
// `simai.core: {folder, abi}`), it is built once instead:
//
// - the build writes a generated entry for the folder that registers every
//   module of it with the page's runtime:
//   SF.runtimeModule.register("<package>", <abi>, {"<module>": namespace});
// - in every other bundle of the package an import from the folder becomes an
//   external, `SF.runtimeModule("<package>/<module>", <abi>)`;
// - the package rule file gets a tagless rule for it, `cl-<folder>`, and every
//   component that imports the core must relate to it, so the Loader fetches
//   the core once, before the first component that needs it runs.
//
// The module name is the file's path inside the folder without its extension
// (`scale` for chart-core/scale.js, `geo/projection` for
// chart-core/geo/projection.js).

const fs = require("node:fs");
const path = require("node:path");

const CORE_FOLDER = /^[a-z][a-z0-9-]*$/u;
const MODULE_FILE = /\.m?js$/u;
const MODULE_NAME = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const ENTRY_FILE = "index.js";
const CONTRACT = "core/contracts/shared-runtime.v1.json";

function compareCodeUnits(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

/** `simai.core` of a package.json, validated: {folder, abi}, or null. */
function validateCoreDeclaration(value, label = "simai.core")
{
    if (value === undefined || value === null)
    {
        return null;
    }

    if (typeof value !== "object" || Array.isArray(value))
    {
        throw new TypeError(`${label} must be {folder, abi}`);
    }

    const extra = Object.keys(value).filter((key) => !["folder", "abi"].includes(key));

    if (extra.length > 0)
    {
        throw new TypeError(`${label} has unknown keys: ${extra.join(", ")}`);
    }

    if (typeof value.folder !== "string" || !CORE_FOLDER.test(value.folder))
    {
        throw new TypeError(`${label}.folder must be a folder name under src/smart: ${String(value.folder)}`);
    }

    if (!Number.isInteger(value.abi) || value.abi < 1)
    {
        throw new TypeError(`${label}.abi must be a positive integer: ${String(value.abi)}`);
    }

    return Object.freeze({ abi: value.abi, folder: value.folder });
}

/** `--core <folder>:<abi>` of the package runner. */
function parseCoreOption(text)
{
    const match = /^([a-z][a-z0-9-]*):([1-9][0-9]*)$/u.exec(String(text));

    if (!match)
    {
        throw new TypeError(`--core must be <folder>:<abi>: ${String(text)}`);
    }

    return validateCoreDeclaration({ abi: Number(match[2]), folder: match[1] }, "--core");
}

function coreRuleName(core)
{
    return `cl-${core.folder}`;
}

function coreEntryKey(core)
{
    return `smart/${core.folder}`;
}

// The core's rule in the package rule file: a Smart rule with a script and no
// tags, which the Loader fetches as a relation of the components that use it.
function coreRule()
{
    return { css: false, js: true, mode: "smart", tags: [], type: "smart" };
}

/**
 * The pinned ui-source must hand out package modules: its shared runtime
 * contract says how (`package_modules`), from core.runtime 1.38.0.
 */
function assertPackageModulesSupported(sourceRoot)
{
    const file = path.join(sourceRoot, CONTRACT);
    const contract = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const declared = contract && contract.package_modules;

    if (!declared || declared.id !== "<package>/<module>" || !Array.isArray(declared.reserved_namespaces))
    {
        throw new Error(`the pinned ui-source has no package modules (${CONTRACT} package_modules, core.runtime 1.38.0); a package core cannot be shared over it`);
    }

    return declared;
}

function listModuleFiles(root, current = root)
{
    return fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => compareCodeUnits(left.name, right.name))
        .flatMap((entry) => {
            const absolute = path.join(current, entry.name);

            if (entry.isDirectory())
            {
                return listModuleFiles(root, absolute);
            }

            return entry.isFile() && MODULE_FILE.test(entry.name)
                ? [path.relative(root, absolute).split(path.sep).join("/")]
                : [];
        });
}

// The runtime hands each bundle a frozen copy of a module's namespace
// (ui-source core/js/package-modules.js), so a binding the module reassigns
// later would stay at its first value in every component.
function assertNoLiveBindings(file)
{
    const acorn = require("acorn");
    const program = acorn.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module" });

    for (const node of program.body)
    {
        if (node.type === "ExportNamedDeclaration" && node.declaration
            && node.declaration.type === "VariableDeclaration" && node.declaration.kind !== "const")
        {
            throw new Error(`${file}: a shared core module exports a live binding (export ${node.declaration.kind}); export a const, a function or a class`);
        }
    }
}

/**
 * The modules of a package's core folder: [{name, file}], sorted by name.
 * Refuses a folder that is a component (it holds a rule.js), holds an entry
 * of its own, holds no module, or a module that exports a live binding.
 */
function coreModules(sourceRoot, core)
{
    const folder = path.join(sourceRoot, "smart", core.folder);

    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
    {
        throw new Error(`the package declares its core in smart/${core.folder}, which it does not have`);
    }

    for (const file of ["rule.js", ENTRY_FILE, "index.scss"])
    {
        if (fs.existsSync(path.join(folder, file)))
        {
            throw new Error(`smart/${core.folder} is the package core and may not hold ${file}: the build writes its entry and its rule`);
        }
    }

    const modules = listModuleFiles(folder).map((relative) => ({
        file: path.join(folder, ...relative.split("/")),
        name: relative.replace(MODULE_FILE, ""),
    }));

    if (modules.length === 0)
    {
        throw new Error(`smart/${core.folder}, the package core, holds no module`);
    }

    const names = new Set();

    for (const module of modules)
    {
        if (!MODULE_NAME.test(module.name))
        {
            throw new Error(`smart/${core.folder}/${module.name}: not a module name (${MODULE_NAME})`);
        }

        if (names.has(module.name))
        {
            throw new Error(`smart/${core.folder}/${module.name}: two files give the module`);
        }

        names.add(module.name);
        assertNoLiveBindings(module.file);
    }

    return modules;
}

/** The generated entry's text; `root` is the core folder. */
function coreEntrySource(packageName, core, root, modules)
{
    const imports = modules.map((module, index) =>
        `import * as m${index} from ${JSON.stringify(`./${path.relative(root, module.file).split(path.sep).join("/")}`)};`);
    const map = modules.map((module, index) => `  ${JSON.stringify(module.name)}: m${index},`);

    return [
        `// Package ${packageName}: its shared core, smart/${core.folder}, built once.`,
        "// Registers its modules with the page's runtime; the package's components",
        `// ask for them as SF.runtimeModule("${packageName}/<module>", ${core.abi}).`,
        "// Generated by ui-builder (libs/packageCore.js); not edited.",
        ...imports,
        "",
        "const modules = {",
        ...map,
        "};",
        "",
        "function register()",
        "{",
        "    const lookup = globalThis.SF && globalThis.SF.runtimeModule;",
        "    if (!lookup || typeof lookup.register !== \"function\")",
        "    {",
        `        globalThis.console.error(new Error("SF runtime: package ${packageName} shares its core through package modules, which this page's SIMAI Framework does not have (core.runtime 1.38.0 or later)."));`,
        "        return;",
        "    }",
        `    lookup.register(${JSON.stringify(packageName)}, ${core.abi}, modules);`,
        "}",
        "",
        "if (globalThis.SF && globalThis.SF.runtimeModule) register();",
        "else globalThis.addEventListener(\"sf-runtime-ready\", register, { once: true });",
        "",
    ].join("\n");
}

/**
 * Write the core's generated entry, smart/<folder>/index.js, into the source
 * tree being built (a package overlay). Returns a function that removes it.
 */
function writeCoreEntry(sourceRoot, packageName, core)
{
    const modules = coreModules(sourceRoot, core);
    const root = path.join(sourceRoot, "smart", core.folder);
    const entry = path.join(root, ENTRY_FILE);
    const text = coreEntrySource(packageName, core, root, modules);
    fs.writeFileSync(entry, text, { flag: "wx" });

    return { entry, modules, remove: () => fs.rmSync(entry, { force: true }) };
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

/**
 * The core module a request names, or null: a relative import, from a file of
 * the source (not a dependency), that resolves into smart/<folder>.
 */
function coreModuleFor({ context, request, issuer }, sourceRoot, core)
{
    if (!request || !request.startsWith(".") || !context
        || (issuer && issuer.includes(`${path.sep}node_modules${path.sep}`)))
    {
        return null;
    }

    const folder = path.join(realDirectory(sourceRoot), "smart", core.folder);
    const target = path.resolve(realDirectory(context), request).replace(MODULE_FILE, "");

    if (!target.startsWith(`${folder}${path.sep}`))
    {
        return null;
    }

    const name = path.relative(folder, target).split(path.sep).join("/");

    return name === "index" ? null : name;
}

/** The file a core module comes from, for the exports check. */
function coreModuleFile(sourceRoot, core, name)
{
    const base = path.join(sourceRoot, "smart", core.folder, ...name.split("/"));

    return [`${base}.js`, `${base}.mjs`].find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * The components that import the core must relate to its rule; one that
 * does not would run before its core arrives on a page the Loader drives.
 */
function assertCoreRelations(rules, core, users)
{
    const ruleName = coreRuleName(core);
    const missing = [...users].sort(compareCodeUnits)
        .map((folder) => `cl-${folder}`)
        .filter((name) => rules[name] && !(rules[name].relation || []).some((relation) => relation && relation.name === ruleName));

    if (missing.length > 0)
    {
        throw new Error(`${missing.join(", ")} import${missing.length === 1 ? "s" : ""} the package core smart/${core.folder} but do${missing.length === 1 ? "es" : ""} not relate to ${ruleName}: add relation [{name: '${ruleName}'}] to the rule`);
    }
}

module.exports = {
    CORE_FOLDER,
    assertCoreRelations,
    assertPackageModulesSupported,
    coreEntryKey,
    coreEntrySource,
    coreModuleFile,
    coreModuleFor,
    coreModules,
    coreRule,
    coreRuleName,
    parseCoreOption,
    validateCoreDeclaration,
    writeCoreEntry,
};
