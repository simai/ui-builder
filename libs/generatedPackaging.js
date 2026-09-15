"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const {
    materializeLegacyRuntimeCompatibility,
} = require("./legacyRuntimeCompatibility");

const SOURCE_ASSET_EXTENSIONS = Object.freeze(new Set([
    ".gif",
    ".html",
    ".jpeg",
    ".jpg",
    ".json",
    ".mjs",
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

function materializeSourceAssets(plan)
{
    const sourceRoot = assertRegularTree(plan.sourceRoot, "sourceRoot");
    const outputRoot = path.resolve(plan.outputRoot);
    const copied = [];

    for (const entry of plan.entries)
    {
        const entryDirectory = path.dirname(entry.input);

        for (const source of walkRegularFiles(entryDirectory, "source asset tree"))
        {
            if (!SOURCE_ASSET_EXTENSIONS.has(path.extname(source).toLowerCase()))
            {
                continue;
            }

            const canonicalSource = fs.realpathSync(source);

            if (!isWithin(sourceRoot, canonicalSource))
            {
                throw new Error(`source asset escapes source root: ${source}`);
            }

            const relativePath = path.relative(sourceRoot, canonicalSource);
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
        const compressed = zlib.gzipSync(fs.readFileSync(source), {
            level: zlib.constants.Z_BEST_COMPRESSION,
            mtime: 0,
        });
        fs.writeFileSync(destination, compressed);
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
    materializeDeterministicGzip,
    materializeEmptyCompatibilityScripts,
    materializeGeneratedPackaging,
    normalizeGeneratedTextWhitespace,
    materializeSourceAssets,
};
