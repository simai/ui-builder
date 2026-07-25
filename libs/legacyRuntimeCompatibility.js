"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BATCH = "RTL-3I-LEGACY-RUNTIME-LINEAGE";
const TARGET_PREFIXES = Object.freeze({
    component: ["component/"],
    core: ["core/"],
    smart: ["smart/"],
});

function compareCodeUnits(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root, candidate)
{
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`)
        && relative !== ".." && !path.isAbsolute(relative));
}

function regularFile(candidate, label)
{
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile())
    {
        throw new Error(`${label} must be a regular file: ${candidate}`);
    }
    return stat;
}

function digest(source)
{
    return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function validateLegacyRuntimeCompatibility(contract)
{
    if (contract === undefined || contract === null)
    {
        return null;
    }
    if (!contract || typeof contract !== "object" || Array.isArray(contract))
    {
        throw new TypeError("legacyCompatibility must be an object");
    }
    if (contract.validated === true)
    {
        return validateLegacyRuntimeCompatibility({
            manifest: contract.manifest,
            revision: contract.revision,
            root: contract.root,
        });
    }
    for (const key of ["root", "manifest"])
    {
        if (typeof contract[key] !== "string" || !path.isAbsolute(contract[key]))
        {
            throw new TypeError(`legacyCompatibility.${key} must be an absolute path`);
        }
    }
    const root = fs.realpathSync(contract.root);
    if (!fs.statSync(root).isDirectory())
    {
        throw new Error("legacyCompatibility.root must be a directory");
    }
    regularFile(contract.manifest, "legacy compatibility manifest");
    const manifest = JSON.parse(fs.readFileSync(contract.manifest, "utf8"));
    if (manifest.batch !== BATCH || manifest.mode !== "read_only_lineage_audit")
    {
        throw new Error("legacy compatibility manifest contract mismatch");
    }
    if (manifest.generated_repository?.revision !== contract.revision)
    {
        throw new Error("legacy compatibility revision mismatch");
    }
    if (!Array.isArray(manifest.records)
        || manifest.records.length !== manifest.summary?.runtime_base_paths
        || manifest.summary?.runtime_paths < manifest.records.length)
    {
        throw new Error("legacy compatibility record count mismatch");
    }
    const records = manifest.records.map(record => {
        if (!record || typeof record.path !== "string"
            || record.path.endsWith(".gz")
            || !Object.values(TARGET_PREFIXES).flat().some(prefix => record.path.startsWith(prefix))
            || !/^[a-f0-9]{64}$/u.test(record.sha256)
            || !Number.isInteger(record.size) || record.size < 0)
        {
            throw new Error("invalid legacy compatibility record");
        }
        const source = path.resolve(root, record.path);
        if (!isWithin(root, source))
        {
            throw new Error("legacy compatibility path escapes root");
        }
        const stat = regularFile(source, "legacy compatibility source");
        if (stat.size !== record.size || digest(source) !== record.sha256)
        {
            throw new Error(`legacy compatibility digest mismatch: ${record.path}`);
        }
        return {...record, source};
    }).sort((left, right) => compareCodeUnits(left.path, right.path));
    if (new Set(records.map(record => record.path)).size !== records.length)
    {
        throw new Error("duplicate legacy compatibility path");
    }
    return {
        manifest: path.resolve(contract.manifest),
        records,
        revision: contract.revision,
        root,
        validated: true,
    };
}

function compatibilityFromEnvironment(environment = process.env)
{
    const root = environment.SF_LEGACY_COMPATIBILITY_ROOT;
    const manifest = environment.SF_LEGACY_COMPATIBILITY_MANIFEST;
    const revision = environment.SF_LEGACY_COMPATIBILITY_REVISION;
    if (!root && !manifest && !revision) return null;
    if (!root || !manifest || !revision)
    {
        throw new Error("all SF_LEGACY_COMPATIBILITY_* variables are required");
    }
    return {manifest, revision, root};
}

function materializeLegacyRuntimeCompatibility(plan)
{
    const contract = validateLegacyRuntimeCompatibility(plan.legacyCompatibility);
    if (!contract) return [];
    const targets = new Set(plan.entries.map(entry => entry.target));
    const written = [];
    for (const record of contract.records)
    {
        const target = Object.entries(TARGET_PREFIXES).find(([, prefixes]) =>
            prefixes.some(prefix => record.path.startsWith(prefix)))?.[0];
        if (!targets.has(target)) continue;
        const destination = path.resolve(plan.outputRoot, record.path);
        if (!isWithin(path.resolve(plan.outputRoot), destination))
        {
            throw new Error("legacy compatibility destination escapes output root");
        }
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        if (fs.existsSync(destination))
        {
            regularFile(destination, "legacy compatibility destination");
            if (!fs.readFileSync(destination).equals(fs.readFileSync(record.source)))
            {
                throw new Error(`legacy compatibility collision: ${record.path}`);
            }
            continue;
        }
        fs.copyFileSync(record.source, destination);
        written.push(destination);
    }
    return written;
}

module.exports = {
    compatibilityFromEnvironment,
    materializeLegacyRuntimeCompatibility,
    validateLegacyRuntimeCompatibility,
};
