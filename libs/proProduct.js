"use strict";

// SIMAI Framework Pro as a product: four Smart components whose source lives in
// ui-source-pro and imports the free Framework by relative path
// (`../../core/js/smart-base`, `../helpers/dom`, `../field-renderers/index.js`).
// ui-source-pro pins the ui-source revision it builds against
// (framework.lock.json); the build runs over an overlay, ui-source at that
// revision with ui-source-pro's tree laid over it, so every relative import
// resolves unchanged. The product keeps only the Pro entries and adds the
// package rule file the Loader fetches from `<base>/rule.js`
// (ui-source docs/developer/component-packages.md).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const PRO_PACKAGE = "pro";
const PRO_COMPONENTS = Object.freeze(["admin-menu", "data-view", "property-view", "table"]);
const PRO_SOURCE_LOCK = "framework.lock.json";
const PRO_SOURCE_LOCK_SCHEMA = "simai.framework-pro.source-lock.v1";
// What of ui-source-pro is laid over ui-source. src is what the build reads;
// tests and docs come along so the same overlay serves the Pro test runner.
const OVERLAY_DIRECTORIES = Object.freeze(["src", "tests", "docs"]);
const RULE_FILE = "smart/rule.js";

function compareCodeUnits(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function git(root, args, options = {})
{
    const result = spawnSync("git", ["-C", root, ...args], {
        encoding: options.encoding === null ? null : "utf8",
        maxBuffer: 512 * 1024 * 1024,
    });

    if (result.error || result.status !== 0)
    {
        const said = String(result.stderr || result.error || "").trim();
        throw new Error(`git ${args.join(" ")} failed in ${root}: ${said}`);
    }

    return result.stdout;
}

function readProSourceLock(proRoot)
{
    const lockPath = path.join(proRoot, PRO_SOURCE_LOCK);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

    if (lock.schema !== PRO_SOURCE_LOCK_SCHEMA)
    {
        throw new Error(`${PRO_SOURCE_LOCK}: schema must be ${PRO_SOURCE_LOCK_SCHEMA}`);
    }

    const revision = lock.source && lock.source.revision;

    if (!/^[0-9a-f]{40}$/u.test(String(revision)))
    {
        throw new Error(`${PRO_SOURCE_LOCK}: source.revision must be a full commit`);
    }

    if (lock.source.repository !== "simai/ui-source")
    {
        throw new Error(`${PRO_SOURCE_LOCK}: source.repository must be simai/ui-source`);
    }

    return lock;
}

function extractArchive(root, revision, paths, destination)
{
    const archive = git(root, ["archive", "--format=tar", revision, ...paths], { encoding: null });
    fs.mkdirSync(destination, { recursive: true });
    const result = spawnSync("tar", ["-x", "-f", "-", "-C", destination], { input: archive });

    if (result.error || result.status !== 0)
    {
        throw new Error(`could not extract ${root}@${revision}: ${String(result.stderr || result.error)}`);
    }
}

function listFiles(root, current = root)
{
    return fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => compareCodeUnits(left.name, right.name))
        .flatMap(entry => {
            const absolute = path.join(current, entry.name);

            if (entry.isDirectory())
            {
                return listFiles(root, absolute);
            }

            return [path.relative(root, absolute).split(path.sep).join("/")];
        });
}

/**
 * Lay out ui-source at the pinned revision and ui-source-pro at `proRevision`
 * over it, in a directory that must not exist yet. Both come from git
 * (`git archive`), never from a working tree, so the overlay is exactly two
 * commits. A Pro file may not replace a ui-source file: Pro adds, it does not
 * shadow the free Framework.
 */
function materializeProOverlay({ overlayRoot, proRevision = "HEAD", proRoot, uiSourceRoot })
{
    if (fs.existsSync(overlayRoot))
    {
        throw new Error(`overlay root must not exist: ${overlayRoot}`);
    }

    const lock = readProSourceLock(proRoot);
    const sourceRevision = lock.source.revision;
    const proCommit = git(proRoot, ["rev-parse", "--verify", `${proRevision}^{commit}`]).trim();
    const lockAtCommit = JSON.parse(git(proRoot, ["show", `${proCommit}:${PRO_SOURCE_LOCK}`]));

    if (lockAtCommit.source.revision !== sourceRevision)
    {
        throw new Error(`${PRO_SOURCE_LOCK} in the working tree and at ${proCommit.slice(0, 12)} pin different ui-source revisions`);
    }

    git(uiSourceRoot, ["cat-file", "-e", `${sourceRevision}^{commit}`]);
    extractArchive(uiSourceRoot, sourceRevision, [], overlayRoot);

    const staging = `${overlayRoot}.pro`;
    fs.rmSync(staging, { force: true, recursive: true });
    const present = OVERLAY_DIRECTORIES.filter(directory =>
        git(proRoot, ["ls-tree", "--name-only", proCommit, directory]).trim() === directory);
    extractArchive(proRoot, proCommit, present, staging);

    const laid = [];

    for (const relative of listFiles(staging))
    {
        const destination = path.join(overlayRoot, relative);

        if (fs.existsSync(destination))
        {
            throw new Error(`ui-source-pro would replace ui-source's ${relative}`);
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(staging, relative), destination);
        laid.push(relative);
    }

    fs.rmSync(staging, { recursive: true });

    for (const name of PRO_COMPONENTS)
    {
        if (!fs.existsSync(path.join(overlayRoot, "src/smart", name)))
        {
            throw new Error(`ui-source-pro has no src/smart/${name}`);
        }
    }

    return {
        laid_files: laid.length,
        pro_revision: proCommit,
        source_revision: sourceRevision,
    };
}

function normalizeRuleValue(value, label)
{
    if (value === null || ["boolean", "string"].includes(typeof value))
    {
        return value;
    }

    if (typeof value === "number" && Number.isFinite(value))
    {
        return value;
    }

    if (Array.isArray(value))
    {
        return value.map((entry, index) => normalizeRuleValue(entry, `${label}[${index}]`));
    }

    if (Object.prototype.toString.call(value) !== "[object Object]")
    {
        // A RegExp or a function cannot cross into the generated rule file as
        // data; a package rule is a tag rule.
        throw new Error(`${label} is not plain data`);
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

/** The rules the Pro components' own rule.js files write, by rule name. */
function collectProRules(sourceRoot)
{
    const rules = {};

    for (const name of PRO_COMPONENTS)
    {
        const source = path.join(sourceRoot, "smart", name, "rule.js");
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
        const written = Object.keys(sandbox.SF.RuleLoader);

        if (written.length !== 1 || written[0] !== `cl-${name}`)
        {
            throw new Error(`smart/${name}/rule.js must write exactly cl-${name}, wrote ${written.join(", ") || "nothing"}`);
        }

        const rule = normalizeRuleValue(sandbox.SF.RuleLoader[written[0]], `rule ${written[0]}`);

        if (rule.type !== "smart" || !Array.isArray(rule.tags) || rule.tags.length === 0 || "package" in rule)
        {
            throw new Error(`rule ${written[0]} must be a Smart tag rule without a package field`);
        }

        rules[written[0]] = rule;
    }

    return Object.fromEntries(Object.keys(rules).sort(compareCodeUnits).map(key => [key, rules[key]]));
}

function renderPackageRuleFile(rules)
{
    return [
        "// SIMAI Framework Pro: the package rule file. The Loader fetches it from",
        "// <base>/rule.js for a page that declares SF_BOOT_CONFIG.packages.pro.",
        "// Generated by ui-builder (the pro product) from smart/*/rule.js; not edited.",
        `SF.RuleLoader.registerPackage(${JSON.stringify(PRO_PACKAGE)}, {`,
        `  rules: ${JSON.stringify(rules, null, 2).split("\n").join("\n  ")},`,
        "});",
        "",
    ].join("\n");
}

function materializeProPackageRule(plan)
{
    const destination = path.resolve(plan.outputRoot, RULE_FILE);
    const payload = renderPackageRuleFile(collectProRules(plan.sourceRoot));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, payload);

    return [destination];
}

function sha256(value)
{
    return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
    OVERLAY_DIRECTORIES,
    PRO_COMPONENTS,
    PRO_PACKAGE,
    PRO_SOURCE_LOCK,
    PRO_SOURCE_LOCK_SCHEMA,
    RULE_FILE,
    collectProRules,
    materializeProOverlay,
    materializeProPackageRule,
    readProSourceLock,
    renderPackageRuleFile,
    sha256,
};
