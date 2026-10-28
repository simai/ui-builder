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
// those top-level keys and nothing else; what they hold is kept whole. A
// source without the list embeds the whole file, as before.

const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_FILE = /[\\/]smart[\\/][a-z][a-z0-9-]*[\\/]component\.json$/u;

function readEmbeddedKeys(sourceRoot)
{
    const file = path.join(sourceRoot, "core/contracts/shared-runtime.v1.json");
    if (!fs.existsSync(file)) return null;
    const keys = JSON.parse(fs.readFileSync(file, "utf8")).component_manifest_keys;
    if (keys === undefined) return null;
    if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string" || !key))
    {
        throw new Error(`${file}: component_manifest_keys must be a non-empty list of names`);
    }
    return Object.freeze([...keys]);
}

// The manifest as a bundle embeds it: the listed keys, in the file's order.
function embeddedManifest(manifest, keys)
{
    if (!keys) return manifest;
    const wanted = new Set(keys);
    return Object.fromEntries(Object.entries(manifest).filter(([key]) => wanted.has(key)));
}

function applyComponentManifestEmbed(configurations, { sourceRoot })
{
    if (!Array.isArray(configurations))
    {
        throw new TypeError("configurations must be an array");
    }
    const keys = readEmbeddedKeys(path.resolve(sourceRoot));
    if (!keys) return null;
    for (const configuration of configurations)
    {
        configuration.module = configuration.module || {};
        configuration.module.rules = [
            ...(configuration.module.rules || []),
            {
                test: MANIFEST_FILE,
                type: "json",
                parser: { parse: (text) => embeddedManifest(JSON.parse(text), keys) },
            },
        ];
    }
    return keys;
}

module.exports = {
    MANIFEST_FILE,
    applyComponentManifestEmbed,
    embeddedManifest,
    readEmbeddedKeys,
};
