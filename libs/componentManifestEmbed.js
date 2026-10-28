"use strict";

// What a Smart bundle embeds of its component.json (2026-10-28). Each element
// imports its own manifest (`import manifest from "./component.json"`) and
// hands it to elementFromManifest; the class exposes it (`manifest`,
// `sfInterface`). Since standard simai.smart-component 1.4 the file also holds
// what only the build, the registry and the docs read -- x-registry, x-rule,
// x-decisions, relations, aliases, examples, the words of the docs -- and a
// JSON import embeds every byte of it: +126 KB minified over 30 bundles at
// pair ui-83158c9c9538.
//
// The keys the runtime reads are the source's to say: ui-source
// core/contracts/shared-runtime.v1.json `component_manifest_keys` (kept
// against element-manifest.js, the assembly's interface registry, the host
// port and the first-paint tools by a contract test there). A bundle embeds
// those top-level keys and nothing else. A source without the list embeds
// the whole file, as before.
//
// Inside those keys the source may also name what the runtime does not read:
// `component_manifest_drop` in the same contract (summary, examples, the
// tools' x- words; kept against the runtime's code by the same test). A key
// named there, at least two levels under a kept key -- inside a named entry,
// settings.<name>.summary or events.<verb>.carries.<field>.summary, never a
// name itself such as the setting settings.description -- is dropped with
// what it holds (2026-10-28, standard 1.4 phase A: the 59 Smart manifests
// embed 98 KB minified instead of 180). A source without that list keeps the
// kept keys whole.

const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_FILE = /[\\/]smart[\\/][a-z][a-z0-9-]*[\\/]component\.json$/u;

function readContract(sourceRoot)
{
    const file = path.join(sourceRoot, "core/contracts/shared-runtime.v1.json");
    return fs.existsSync(file) ? { file, contract: JSON.parse(fs.readFileSync(file, "utf8")) } : null;
}

function readEmbeddedKeys(sourceRoot)
{
    const found = readContract(sourceRoot);
    if (!found) return null;
    const { file } = found;
    const keys = found.contract.component_manifest_keys;
    if (keys === undefined) return null;
    if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string" || !key))
    {
        throw new Error(`${file}: component_manifest_keys must be a non-empty list of names`);
    }
    return Object.freeze([...keys]);
}

// The nested keys the source lets a bundle drop, or null (keep the kept keys whole).
function readEmbeddedDrop(sourceRoot)
{
    const found = readContract(sourceRoot);
    if (!found) return null;
    const drop = found.contract.component_manifest_drop;
    if (drop === undefined) return null;
    if (!Array.isArray(drop) || drop.some((key) => typeof key !== "string" || !key))
    {
        throw new Error(`${found.file}: component_manifest_drop must be a list of names`);
    }
    return Object.freeze([...drop]);
}

// A kept key's value without the dropped keys at `level` 2 and below: the
// value of a kept key is level 0, the names it declares level 1.
function withoutDropped(node, drop, level)
{
    if (Array.isArray(node)) return node.map((item) => withoutDropped(item, drop, level + 1));
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, value] of Object.entries(node))
    {
        if (level + 1 >= 2 && drop.has(key)) continue;
        out[key] = withoutDropped(value, drop, level + 1);
    }
    return out;
}

// The manifest as a bundle embeds it: the listed keys, in the file's order,
// without the dropped keys inside them.
function embeddedManifest(manifest, keys, drop = null)
{
    if (!keys) return manifest;
    const wanted = new Set(keys);
    const dropped = drop && drop.length ? new Set(drop) : null;
    return Object.fromEntries(Object.entries(manifest)
        .filter(([key]) => wanted.has(key))
        .map(([key, value]) => [key, dropped ? withoutDropped(value, dropped, 0) : value]));
}

function applyComponentManifestEmbed(configurations, { sourceRoot })
{
    if (!Array.isArray(configurations))
    {
        throw new TypeError("configurations must be an array");
    }
    const keys = readEmbeddedKeys(path.resolve(sourceRoot));
    if (!keys) return null;
    const drop = readEmbeddedDrop(path.resolve(sourceRoot));
    for (const configuration of configurations)
    {
        configuration.module = configuration.module || {};
        configuration.module.rules = [
            ...(configuration.module.rules || []),
            {
                test: MANIFEST_FILE,
                type: "json",
                parser: { parse: (text) => embeddedManifest(JSON.parse(text), keys, drop) },
            },
        ];
    }
    return keys;
}

module.exports = {
    MANIFEST_FILE,
    applyComponentManifestEmbed,
    embeddedManifest,
    readEmbeddedDrop,
    readEmbeddedKeys,
};
