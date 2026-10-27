"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const pako = require("pako");
const crypto = require("node:crypto");
const {
    materializeLegacyRuntimeCompatibility,
} = require("./legacyRuntimeCompatibility");

const SOURCE_ASSET_EXTENSIONS = Object.freeze(new Set([
    ".gif",
    ".html",
    ".jpeg",
    ".jpg",
    ".json",
    ".otf",
    ".png",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
]));
const GZIP_EXTENSIONS = Object.freeze(new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".mjs",
    ".svg",
]));
const NORMALIZED_TEXT_EXTENSIONS = Object.freeze(new Set([
    ".js",
    ".mjs",
]));

function compareCodeUnits(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root, candidate)
{
    const relative = path.relative(root, candidate);

    return relative === ""
        || (!relative.startsWith(`..${path.sep}`)
            && relative !== ".."
            && !path.isAbsolute(relative));
}

function assertRegularTree(root, label)
{
    const canonicalRoot = fs.realpathSync(root);

    if (!fs.statSync(canonicalRoot).isDirectory())
    {
        throw new Error(`${label} must be a directory`);
    }

    return canonicalRoot;
}

function sortedEntries(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => compareCodeUnits(left.name, right.name));
}

function walkRegularFiles(root, label)
{
    const files = [];

    function visit(directory)
    {
        for (const dirent of sortedEntries(directory))
        {
            const candidate = path.join(directory, dirent.name);
            const stat = fs.lstatSync(candidate);

            if (stat.isSymbolicLink())
            {
                throw new Error(`${label} contains a symlink: ${candidate}`);
            }

            if (stat.isDirectory())
            {
                visit(candidate);
            }
            else if (stat.isFile())
            {
                files.push(candidate);
            }
        }
    }

    visit(root);

    return files;
}

function safeDestination(outputRoot, relativePath, label)
{
    const destination = path.resolve(outputRoot, relativePath);

    if (!isWithin(outputRoot, destination) || destination === outputRoot)
    {
        throw new Error(`${label} escapes output root`);
    }

    return destination;
}

const IMPORT_SPECIFIER = /(?:^|[;\s])(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu;

function materializeSourceAssets(plan)
{
    const sourceRoot = assertRegularTree(plan.sourceRoot, "sourceRoot");
    const outputRoot = path.resolve(plan.outputRoot);
    const copied = [];
    const normativeAssets = new Set();
    const contractsRoot = path.join(sourceRoot, "core/contracts");
    const normativeLocks = [{
        contractRoot: path.join(contractsRoot, "composition-recipe-v1"),
        schema: "simai.composition.recipe-contract-lock.v1",
        label: "Recipe",
    }];

    if (fs.existsSync(contractsRoot) && fs.lstatSync(contractsRoot).isDirectory())
    {
        for (const directory of fs.readdirSync(contractsRoot).sort())
        {
            if (/^composition-[a-z0-9-]+-v[0-9]+$/u.test(directory) && directory !== "composition-recipe-v1")
            {
                normativeLocks.push({
                    contractRoot: path.join(contractsRoot, directory),
                    schema: "simai.composition.capability-contract-lock.v1",
                    label: `Composition capability ${directory}`,
                });
            }
        }
    }

    for (const { contractRoot, schema, label } of normativeLocks)
    {
        const lockPath = path.join(contractRoot, "contract.lock.json");

        if (!plan.entries.some((entry) => entry.target === "core") || !fs.existsSync(lockPath))
        {
            continue;
        }

        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

        if (lock.schema !== schema
            || !lock.normativeFiles || typeof lock.normativeFiles !== "object"
            || Array.isArray(lock.normativeFiles))
        {
            throw new Error(`invalid ${label} normative-file lock`);
        }

        for (const [relative, expected] of Object.entries(lock.normativeFiles))
        {
            if (!relative || relative.includes("\\") || path.isAbsolute(relative)
                || relative.split("/").some((part) => part === ".." || part === "."))
            {
                throw new Error(`invalid ${label} normative path: ${relative}`);
            }

            const asset = path.resolve(contractRoot, relative);

            if (!isWithin(contractRoot, asset) || !fs.existsSync(asset)
                || !fs.lstatSync(asset).isFile()
                || !isWithin(contractRoot, fs.realpathSync(asset)))
            {
                throw new Error(`missing or unsafe ${label} normative file: ${relative}`);
            }

            const actual = `sha256:${crypto.createHash("sha256")
                .update(fs.readFileSync(asset)).digest("hex")}`;

            if (actual !== expected)
            {
                throw new Error(`${label} normative digest mismatch: ${relative}`);
            }

            normativeAssets.add(fs.realpathSync(asset));
        }
    }

    for (const entry of plan.entries)
    {
        const entryDirectory = path.dirname(entry.input);

        for (const source of walkRegularFiles(entryDirectory, "source asset tree"))
        {
            const canonicalSource = fs.realpathSync(source);

            if (!isWithin(sourceRoot, canonicalSource))
            {
                throw new Error(`source asset escapes source root: ${source}`);
            }

            const relativePath = path.relative(sourceRoot, canonicalSource);
            const extension = path.extname(canonicalSource).toLowerCase();
            const portableRelativePath = relativePath.split(path.sep).join("/");

            if (!SOURCE_ASSET_EXTENSIONS.has(extension) && !normativeAssets.has(canonicalSource)
                && !(extension === ".mjs"
                    && /^core\/js\/(?:composition|assembly)\/[A-Za-z0-9._-]+\.mjs$/u.test(portableRelativePath)))
            {
                continue;
            }

            const destination = safeDestination(outputRoot, relativePath, "source asset");
            fs.mkdirSync(path.dirname(destination), { recursive: true });

            if (fs.existsSync(destination))
            {
                if (!fs.statSync(destination).isFile()
                    || !fs.readFileSync(destination).equals(fs.readFileSync(canonicalSource)))
                {
                    throw new Error(`source asset collides with generated output: ${destination}`);
                }
            }
            else
            {
                fs.copyFileSync(canonicalSource, destination);
            }

            copied.push(destination);
        }
    }

    // What a shipped module imports by a relative path ships with it, and what
    // that imports, so the source modules work where they are laid: the
    // composition modules import ../page-language.js and their own
    // schema-name.mjs (2026-10-18); the assembly modules (SF.Assembly,
    // 2026-10-27) import ../page-language.js too. Only scripts under the
    // source root.
    const queue = copied.filter((file) => path.extname(file).toLowerCase() === ".mjs");

    while (queue.length)
    {
        const file = queue.shift();

        for (const match of fs.readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER))
        {
            const specifier = match[1] || match[2];
            const destination = path.resolve(path.dirname(file), specifier);
            const relativePath = path.relative(outputRoot, destination);
            const source = path.join(sourceRoot, relativePath);

            if (!isWithin(outputRoot, destination) || fs.existsSync(destination)
                || !/\.m?js$/u.test(destination) || !fs.existsSync(source) || !fs.statSync(source).isFile())
            {
                continue;
            }

            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(fs.realpathSync(source), destination);
            copied.push(destination);
            queue.push(destination);
        }
    }

    return copied;
}

function entryLeaf(entry)
{
    return path.basename(entry.key);
}

function isStylesheetOnlyCompatibilityScript(source)
{
    return /^\s*import\s+["']\.\/scss\/index\.scss["'];?\s*$/u.test(source);
}

function materializeEmptyCompatibilityScripts(plan)
{
    const written = [];

    for (const entry of plan.entries)
    {
        if (path.extname(entry.input).toLowerCase() !== ".scss")
        {
            continue;
        }

        const compatibilitySource = path.join(path.dirname(entry.input), "index.js");
        let stat;

        try
        {
            stat = fs.lstatSync(compatibilitySource);
        }
        catch (error)
        {
            if (error && error.code === "ENOENT")
            {
                stat = null;
            }
            else
            {
                throw error;
            }
        }

        if (stat && (stat.isSymbolicLink() || !stat.isFile()))
        {
            throw new Error(`compatibility script source must be a regular file: ${compatibilitySource}`);
        }

        const source = stat
            ? fs.readFileSync(compatibilitySource, "utf8")
            : "";

        if (source.length > 0 && !isStylesheetOnlyCompatibilityScript(source))
        {
            throw new Error(`uncompiled compatibility script is not stylesheet-only: ${compatibilitySource}`);
        }

        const destination = safeDestination(
            plan.outputRoot,
            path.relative(
                plan.outputRoot,
                path.join(entry.outputDirectory, "js", `${entryLeaf(entry)}.js`),
            ),
            "compatibility script",
        );

        if (!fs.existsSync(destination))
        {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, Buffer.alloc(0));
            written.push(destination);
        }
    }

    return written;
}

function materializeUtilityAggregateCompatibility(plan)
{
    if (!plan.entries.some(entry => entry.target === "utility"))
    {
        return [];
    }

    const destination = safeDestination(
        plan.outputRoot,
        "utility/js/utility.js",
        "utility aggregate compatibility script",
    );

    if (fs.existsSync(destination))
    {
        if (!fs.statSync(destination).isFile()
            || fs.statSync(destination).size !== 0)
        {
            throw new Error(`utility aggregate compatibility script collides with generated output: ${destination}`);
        }

        return [];
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.alloc(0));

    return [destination];
}

function normalizeRuleValue(value, label)
{
    if (value === null
        || typeof value === "boolean"
        || typeof value === "string")
    {
        return value;
    }

    if (typeof value === "number" && Number.isFinite(value))
    {
        return value;
    }

    if (Object.prototype.toString.call(value) === "[object RegExp]")
    {
        return String(value);
    }

    if (Array.isArray(value))
    {
        return value.map((entry, index) => normalizeRuleValue(
            entry,
            `${label}[${index}]`,
        ));
    }

    if (Object.prototype.toString.call(value) !== "[object Object]")
    {
        throw new Error(`${label} contains a non-serializable value`);
    }

    const normalized = {};

    for (const key of Object.keys(value).sort(compareCodeUnits))
    {
        if (["__proto__", "constructor", "prototype"].includes(key))
        {
            throw new Error(`${label} contains a dangerous key`);
        }

        normalized[key] = normalizeRuleValue(value[key], `${label}.${key}`);
    }

    return normalized;
}

function collectRuleManifest(sourceRoot)
{
    const rules = new Map();

    for (const scope of ["utility", "component", "smart"])
    {
        const scopeRoot = path.join(sourceRoot, scope);

        if (!fs.existsSync(scopeRoot))
        {
            continue;
        }

        for (const source of walkRegularFiles(scopeRoot, `${scope} rule tree`))
        {
            if (path.basename(source) !== "rule.js")
            {
                continue;
            }

            const sandbox = Object.create(null);
            sandbox.SF = { RuleLoader: Object.create(null) };
            const context = vm.createContext(sandbox, {
                codeGeneration: { strings: false, wasm: false },
            });
            vm.runInContext(fs.readFileSync(source, "utf8"), context, {
                displayErrors: true,
                filename: source,
                timeout: 100,
            });

            for (const [name, value] of Object.entries(sandbox.SF.RuleLoader))
            {
                const rule = normalizeRuleValue(value, `rule ${name}`);
                const record = typeof rule === "string"
                    ? { name, regex: rule }
                    : { name, ...rule };
                const serialized = JSON.stringify(record);

                if (rules.has(name) && JSON.stringify(rules.get(name)) !== serialized)
                {
                    throw new Error(`conflicting rule definition: ${name}`);
                }

                rules.set(name, record);
            }
        }
    }

    return [...rules.values()].sort((left, right) => compareCodeUnits(
        left.name,
        right.name,
    ));
}

function materializeRuleManifest(plan)
{
    if (!plan.entries.some(entry => entry.target === "core"))
    {
        return [];
    }

    const destination = safeDestination(
        plan.outputRoot,
        "rule/rule.json",
        "rule manifest",
    );
    const payload = `${JSON.stringify(
        collectRuleManifest(assertRegularTree(plan.sourceRoot, "sourceRoot")),
        null,
        2,
    )}\n`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, payload);

    return [destination];
}

function materializeCoreUtilityAggregate(plan)
{
    if (!plan.entries.some(entry => entry.target === "core"))
    {
        return [];
    }

    const stagingRoot = safeDestination(
        plan.outputRoot,
        ".compat/utility-full",
        "Core utility aggregate staging root",
    );
    const stagedCss = path.join(stagingRoot, "css/utility.full.css");
    const stagingStat = fs.existsSync(stagingRoot)
        ? fs.lstatSync(stagingRoot)
        : null;
    const stagedCssStat = fs.existsSync(stagedCss)
        ? fs.lstatSync(stagedCss)
        : null;

    if (!stagingStat
        || stagingStat.isSymbolicLink()
        || !stagingStat.isDirectory()
        || !stagedCssStat
        || stagedCssStat.isSymbolicLink()
        || !stagedCssStat.isFile())
    {
        throw new Error("Core utility aggregate CSS was not compiled");
    }

    const destination = safeDestination(
        plan.outputRoot,
        "core/css/utility.full.css",
        "Core utility aggregate",
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(stagedCss, destination);
    fs.rmSync(stagingRoot, { recursive: true });

    const compatibilityRoot = path.dirname(stagingRoot);

    if (fs.existsSync(compatibilityRoot)
        && fs.readdirSync(compatibilityRoot).length === 0)
    {
        fs.rmdirSync(compatibilityRoot);
    }

    return [destination];
}

// The same bytes on every platform. Node's zlib wrote a gzip whose header
// names the operating system (macOS 0x13, Linux 0x03) and whose deflate stream
// differs between builds of zlib (arm64 macOS and x64 Linux): every file it
// compressed was equal once decompressed and different as bytes, so a package
// built on a Mac could not be reproduced in Linux CI (DEV, ui-doc CI,
// 2026-10-16). pako deflates in JavaScript, the same everywhere; the header is
// fixed -- no time, no file name, operating system unknown (255).
function deterministicGzip(bytes)
{
    return Buffer.from(pako.gzip(bytes, { level: 9, header: { os: 255, time: 0 } }));
}

function materializeDeterministicGzip(outputRoot)
{
    if (!fs.existsSync(outputRoot))
    {
        return [];
    }

    const canonicalRoot = assertRegularTree(outputRoot, "outputRoot");
    const written = [];

    for (const source of walkRegularFiles(canonicalRoot, "generated output tree"))
    {
        if (!GZIP_EXTENSIONS.has(path.extname(source).toLowerCase()))
        {
            continue;
        }

        const destination = `${source}.gz`;
        fs.writeFileSync(destination, deterministicGzip(fs.readFileSync(source)));
        written.push(destination);
    }

    return written;
}

function normalizeGeneratedTextWhitespace(outputRoot)
{
    if (!fs.existsSync(outputRoot))
    {
        return [];
    }

    const canonicalRoot = assertRegularTree(outputRoot, "outputRoot");
    const normalized = [];

    for (const source of walkRegularFiles(canonicalRoot, "generated output tree"))
    {
        if (!NORMALIZED_TEXT_EXTENSIONS.has(path.extname(source).toLowerCase()))
        {
            continue;
        }

        const original = fs.readFileSync(source, "utf8");
        const canonical = original.replace(/[ \t]+$/gmu, "");

        if (canonical !== original)
        {
            fs.writeFileSync(source, canonical);
            normalized.push(source);
        }
    }

    return normalized;
}

// Every relative import of a module the distribution ships as source (the
// composition modules under core/js/composition and the assembly modules
// under core/js/assembly) resolves to a file the
// distribution holds. ui-1cb0739a8423 shipped composition modules importing
// ../schema-name.mjs, a file the copy rule did not ship, and every consumer
// that imported them failed with ERR_MODULE_NOT_FOUND (DEV, 2026-10-18).

function assertShippedModuleImports(outputRoot, files)
{
    const unresolved = [];

    for (const file of files)
    {
        if (path.extname(file).toLowerCase() !== ".mjs")
        {
            continue;
        }

        const source = fs.readFileSync(file, "utf8");

        for (const match of source.matchAll(IMPORT_SPECIFIER))
        {
            const specifier = match[1] || match[2];
            const target = path.resolve(path.dirname(file), specifier);

            if (!isWithin(outputRoot, target) || !fs.existsSync(target) || !fs.statSync(target).isFile())
            {
                unresolved.push(`${path.relative(outputRoot, file)} imports ${specifier}`);
            }
        }
    }

    if (unresolved.length)
    {
        throw new Error(`a shipped module imports a file the distribution does not hold: ${unresolved.join("; ")}`);
    }
}

function materializeGeneratedPackaging(plan)
{
    if (!fs.existsSync(plan.outputRoot))
    {
        return {
            compatibilityScripts: [],
            aggregateAssets: [],
            gzip: [],
            legacyRuntimeCompatibility: [],
            normalizedText: [],
            ruleManifests: [],
            sourceAssets: [],
        };
    }

    const sourceAssets = materializeSourceAssets(plan);
    assertShippedModuleImports(plan.outputRoot, sourceAssets);
    const aggregateAssets = materializeCoreUtilityAggregate(plan);
    const compatibilityScripts = [
        ...materializeEmptyCompatibilityScripts(plan),
        ...materializeUtilityAggregateCompatibility(plan),
    ];
    const ruleManifests = materializeRuleManifest(plan);
    const legacyRuntimeCompatibility = materializeLegacyRuntimeCompatibility(plan);
    const normalizedText = normalizeGeneratedTextWhitespace(plan.outputRoot);
    const gzip = materializeDeterministicGzip(plan.outputRoot);

    return {
        aggregateAssets,
        compatibilityScripts,
        gzip,
        legacyRuntimeCompatibility,
        normalizedText,
        ruleManifests,
        sourceAssets,
    };
}

module.exports = {
    assertShippedModuleImports,
    deterministicGzip,
    materializeDeterministicGzip,
    materializeEmptyCompatibilityScripts,
    materializeGeneratedPackaging,
    normalizeGeneratedTextWhitespace,
    materializeSourceAssets,
};
