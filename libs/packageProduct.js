"use strict";

// Product component packages. A product (Larena, Docara, ...) keeps its own
// Smart components in a folder of its own UI repository, laid out like
// ui-source:
//
//   <package path>/framework.lock.json    the ui-source revision it builds on
//   <package path>/src/smart/<folder>/    one folder per component
//   <package path>/tests/, docs/          optional; laid out for its tests
//
// The components import the free Framework by relative path
// (`../../core/js/smart-base`, `../helpers/dom`, ...). The build runs over an
// overlay, ui-source at the pinned revision with the package's src/, tests/
// and docs/ laid over it, so every relative import resolves unchanged. The
// output keeps only the package's own folders and adds the package rule file
// the Loader fetches from `<base>/rule.js` for a page that declares
// `SF_BOOT_CONFIG.packages.<name>` (ui-source
// docs/developer/component-packages.md).
//
// The package path may be a subdirectory of a larger repository: everything
// is read from git at one commit (`git archive <commit>:<path>`), never from a
// working tree.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/u;
const COMPONENT_FOLDER = /^[a-z][a-z0-9-]*$/u;
const SOURCE_LOCK = "framework.lock.json";
const SOURCE_LOCK_SCHEMA = "simai.framework.product-package-source-lock.v1";
// SIMAI Framework Pro's lock, read until ui-source-pro moves into a product.
const LEGACY_SOURCE_LOCK_SCHEMAS = Object.freeze(["simai.framework-pro.source-lock.v1"]);
// What of the package is laid over ui-source. src is what the build reads;
// tests and docs come along so the same overlay serves the package's tests.
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

function assertPackageName(name)
{
    if (typeof name !== "string" || !PACKAGE_NAME.test(name))
    {
        throw new Error(`package name must match ${PACKAGE_NAME}: ${String(name)}`);
    }

    return name;
}

/**
 * The repository that holds a package, and the package's path inside it.
 * Either `repositoryRoot` (+ `packagePath`, default the repository root) or
 * `packageRoot`, any directory inside a git checkout.
 */
function resolvePackageSource({ packageRoot, repositoryRoot, packagePath = "" })
{
    let root = repositoryRoot;
    let subdirectory = packagePath;

    if (!root)
    {
        if (!packageRoot)
        {
            throw new Error("a package source needs a repository or a package root");
        }

        root = git(packageRoot, ["rev-parse", "--show-toplevel"]).trim();
        subdirectory = path.relative(fs.realpathSync(root), fs.realpathSync(packageRoot));
    }
    else if (packageRoot)
    {
        throw new Error("give either a package root or a repository with a package path, not both");
    }

    const posix = path.posix.normalize(String(subdirectory || ".").split(path.sep).join("/"))
        .replace(/\/$/u, "");
    const normalized = posix === "." ? "" : posix;

    if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized))
    {
        throw new Error(`package path must lie inside the repository: ${subdirectory}`);
    }

    return { repositoryRoot: path.resolve(root), packagePath: normalized };
}

function atPath(packagePath, relative)
{
    return packagePath ? `${packagePath}/${relative}` : relative;
}

function validateSourceLock(lock, label, packageName)
{
    if (lock.schema !== SOURCE_LOCK_SCHEMA && !LEGACY_SOURCE_LOCK_SCHEMAS.includes(lock.schema))
    {
        throw new Error(`${label}: schema must be ${SOURCE_LOCK_SCHEMA}`);
    }

    const revision = lock.source && lock.source.revision;

    if (!/^[0-9a-f]{40}$/u.test(String(revision)))
    {
        throw new Error(`${label}: source.revision must be a full commit`);
    }

    if (lock.source.repository !== "simai/ui-source")
    {
        throw new Error(`${label}: source.repository must be simai/ui-source`);
    }

    if (lock.package !== undefined && packageName !== undefined && lock.package !== packageName)
    {
        throw new Error(`${label}: declares package ${String(lock.package)}, built as ${packageName}`);
    }

    return lock;
}

function extractArchive(root, treeish, paths, destination)
{
    const archive = git(root, ["archive", "--format=tar", treeish, ...paths], { encoding: null });
    fs.mkdirSync(destination, { recursive: true });
    const result = spawnSync("tar", ["-x", "-f", "-", "-C", destination], { input: archive });

    if (result.error || result.status !== 0)
    {
        throw new Error(`could not extract ${root}@${treeish}: ${String(result.stderr || result.error)}`);
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
 * The components a package holds at a commit: each src/smart/<folder> with a
 * rule.js. Another folder there (a helper module of the package's own) is
 * laid into the overlay but is not a component.
 */
function packageComponents(repositoryRoot, commit, packagePath)
{
    const smart = atPath(packagePath, "src/smart");
    const present = git(repositoryRoot, ["ls-tree", "--name-only", commit, `${smart}`]).trim();

    if (present !== smart)
    {
        return [];
    }

    const listing = git(repositoryRoot, ["ls-tree", "-r", "--name-only", `${commit}:${smart}`]);

    return listing.split("\n")
        .filter(entry => /^[^/]+\/rule\.js$/u.test(entry))
        .map(entry => entry.slice(0, -"/rule.js".length))
        .sort(compareCodeUnits);
}

/**
 * Lay out ui-source at the revision the package pins, with the package's
 * src/, tests/ and docs/ at `revision` laid over it, in a directory that must
 * not exist yet. Both come from git, so the overlay is exactly two commits. A
 * package file may not replace a ui-source file: a package adds to the
 * Framework, it does not shadow it. `components`, when given, is the exact set
 * of folders the package must hold; otherwise every folder under src/smart is
 * a component.
 */
function materializePackageOverlay({
    components,
    overlayRoot,
    packageName,
    packagePath = "",
    repositoryRoot,
    revision = "HEAD",
    uiSourceRoot,
})
{
    if (fs.existsSync(overlayRoot))
    {
        throw new Error(`overlay root must not exist: ${overlayRoot}`);
    }

    const commit = git(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`]).trim();
    const lockPath = atPath(packagePath, SOURCE_LOCK);
    let lockSource;

    try
    {
        lockSource = git(repositoryRoot, ["show", `${commit}:${lockPath}`]);
    }
    catch (error)
    {
        throw new Error(`${lockPath} is missing at ${commit.slice(0, 12)}`);
    }

    const lock = validateSourceLock(JSON.parse(lockSource), SOURCE_LOCK, packageName);
    const sourceRevision = lock.source.revision;

    git(uiSourceRoot, ["cat-file", "-e", `${sourceRevision}^{commit}`]);
    extractArchive(uiSourceRoot, sourceRevision, [], overlayRoot);

    const staging = `${overlayRoot}.package`;
    fs.rmSync(staging, { force: true, recursive: true });
    const treeish = packagePath ? `${commit}:${packagePath}` : commit;
    const present = OVERLAY_DIRECTORIES.filter(directory =>
        git(repositoryRoot, ["ls-tree", "--name-only", treeish, directory]).trim() === directory);
    extractArchive(repositoryRoot, treeish, present, staging);

    const laid = [];

    for (const relative of listFiles(staging))
    {
        const destination = path.join(overlayRoot, relative);

        if (fs.existsSync(destination))
        {
            throw new Error(`the package would replace ui-source's ${relative}`);
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(staging, relative), destination);
        laid.push(relative);
    }

    fs.rmSync(staging, { recursive: true });

    const found = packageComponents(repositoryRoot, commit, packagePath);
    const invalid = found.filter(name => !COMPONENT_FOLDER.test(name));

    if (invalid.length > 0)
    {
        throw new Error(`component folder names must match ${COMPONENT_FOLDER}: ${invalid.join(", ")}`);
    }

    if (components)
    {
        const missing = components.filter(name => !found.includes(name));
        const extra = found.filter(name => !components.includes(name));

        if (missing.length > 0)
        {
            throw new Error(`the package has no src/smart/${missing.join(", src/smart/")}`);
        }

        if (extra.length > 0)
        {
            throw new Error(`the package holds src/smart/${extra.join(", src/smart/")}, not one of ${components.join(", ")}`);
        }
    }
    else if (found.length === 0)
    {
        throw new Error(`the package holds no component under ${atPath(packagePath, "src/smart")}`);
    }

    return {
        components: [...(components || found)].sort(compareCodeUnits),
        laid_files: laid.length,
        package_path: packagePath,
        package_revision: commit,
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

/**
 * The rules the package's own smart/<folder>/rule.js files write, by rule
 * name. Each runs in a sandbox and must write exactly its own `cl-<folder>`
 * rule, as plain data, a Smart tag rule without a `package` field (the Loader
 * stamps the package when the page declares it).
 */
function collectPackageRules(sourceRoot, components)
{
    const rules = {};
    const tags = new Map();

    for (const name of components)
    {
        const source = path.join(sourceRoot, "smart", name, "rule.js");

        if (!fs.existsSync(source))
        {
            throw new Error(`smart/${name} has no rule.js`);
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

        for (const tag of rule.tags)
        {
            if (tags.has(tag))
            {
                throw new Error(`rules ${tags.get(tag)} and ${written[0]} both claim <${tag}>`);
            }

            tags.set(tag, written[0]);
        }

        rules[written[0]] = rule;
    }

    return Object.fromEntries(Object.keys(rules).sort(compareCodeUnits).map(key => [key, rules[key]]));
}

function defaultRuleFileHeader(packageName)
{
    return [
        `// Package ${packageName}: the package rule file. The Loader fetches it from`,
        `// <base>/rule.js for a page that declares SF_BOOT_CONFIG.packages.${packageName}.`,
        `// Generated by ui-builder (the ${packageName} package) from smart/*/rule.js; not edited.`,
    ];
}

function renderPackageRuleFile(packageName, rules, header = defaultRuleFileHeader(packageName))
{
    assertPackageName(packageName);

    return [
        ...header,
        `SF.RuleLoader.registerPackage(${JSON.stringify(packageName)}, {`,
        `  rules: ${JSON.stringify(rules, null, 2).split("\n").join("\n  ")},`,
        "});",
        "",
    ].join("\n");
}

/** Read back the rules a generated package rule file registers. */
function readPackageRuleFile(source)
{
    const match = /^(?:\/\/[^\n]*\n)*SF\.RuleLoader\.registerPackage\("([a-z][a-z0-9-]*)", \{\n {2}rules: ([\s\S]*),\n\}\);\n$/u.exec(source);

    if (!match)
    {
        throw new Error("not a generated package rule file");
    }

    return { packageName: match[1], rules: JSON.parse(match[2]) };
}

/**
 * Write <outputRoot>/smart/rule.js for a package. `pkg` is
 * {name, components, header?}.
 */
function materializePackageRule(plan, pkg)
{
    const destination = path.resolve(plan.outputRoot, RULE_FILE);
    const payload = renderPackageRuleFile(
        pkg.name,
        collectPackageRules(plan.sourceRoot, pkg.components),
        pkg.header,
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, payload);

    return [destination];
}

function sha256(value)
{
    return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
    COMPONENT_FOLDER,
    LEGACY_SOURCE_LOCK_SCHEMAS,
    OVERLAY_DIRECTORIES,
    PACKAGE_NAME,
    RULE_FILE,
    SOURCE_LOCK,
    SOURCE_LOCK_SCHEMA,
    assertPackageName,
    collectPackageRules,
    defaultRuleFileHeader,
    extractArchive,
    git,
    materializePackageOverlay,
    materializePackageRule,
    packageComponents,
    readPackageRuleFile,
    renderPackageRuleFile,
    resolvePackageSource,
    sha256,
    validateSourceLock,
};
