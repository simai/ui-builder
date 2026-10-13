"use strict";
// Which Framework elements a package component draws without declaring the
// rule that loads them.
//
// A package component's rule lists, as relations, the Framework rules its
// templates need (relation: [{name: 'cl-buttons'}, ...]). The Loader fetches
// those before the component renders. A relation left out is not an error the
// page reports: the element still upgrades once something else on the page
// pulls its rule in, and its styles arrive whenever that happens. The
// documentation trial built a package without a relation to buttons and saw
// sf-button unstyled in 3 of 12 cold loads. sf-build cannot know every element
// a component creates at run time, so this is a warning, read from the source:
// the tags written in templates (<sf-button ...>), the tag names passed as
// strings (SF.create('sf-button'), component: 'sf-button') and the component
// descriptors a Smart element renders (component: {type: 'icon-button'}).
const fs = require("node:fs");
const path = require("node:path");

const RULE_KEY = /SF\.RuleLoader(?:\[['"]([^'"]+)['"]\]|\.([A-Za-z0-9_-]+))\s*=/u;

function readRule(file)
{
    const source = fs.readFileSync(file, "utf8");
    const match = source.match(RULE_KEY);
    if (!match) return null;
    const tags = [...(source.match(/tags\s*:\s*\[([^\]]*)\]/u)?.[1] || "").matchAll(/['"](sf-[a-z0-9-]+)['"]/gu)].map((m) => m[1]);
    const relations = new Set([...source.matchAll(/name\s*:\s*['"]([^'"]+)['"]/gu)].map((m) => m[1]));
    return { key: match[1] || match[2], tags, relations };
}

function folders(root)
{
    const smart = path.join(root, "src", "smart");
    if (!fs.existsSync(smart)) return [];
    return fs.readdirSync(smart, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(smart, entry.name));
}

function sources(directory)
{
    const files = [];
    const walk = (dir) =>
    {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
        {
            if (entry.name === "node_modules" || entry.name === "docs") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(m?js|ts)$/u.test(entry.name) && entry.name !== "rule.js" && entry.name !== "meta.mjs") files.push(full);
        }
    };
    walk(directory);
    return files;
}

// Elements the component fetches itself before it makes them
// (SF.Loader.ensureSmartElementLoaded('sf-radio'), a helper taking a list of
// tags): loaded on demand, so not a missing relation.
function ensuredTags(source)
{
    const tags = new Set();
    for (const call of source.matchAll(/ensure\w*(?:\?\.)?\(([^)]*)\)/gu))
    {
        for (const match of call[1].matchAll(/['"](sf-[a-z0-9-]+)['"]/gu)) tags.add(match[1]);
    }
    return tags;
}

// The Framework elements a source draws.
function drawnTags(source)
{
    const tags = new Set();
    for (const match of source.matchAll(/<(sf-[a-z0-9-]+)[\s>/]/gu)) tags.add(match[1]);
    // A string is a tag only where an element is made or named as one: a class
    // name 'sf-icon' on a span is not an sf-icon element.
    for (const match of source.matchAll(/(?:createElement|SF\.create|whenDefined|component\s*:)\s*\(?\s*['"](sf-[a-z0-9-]+)['"]/gu)) tags.add(match[1]);
    for (const match of source.matchAll(/component\s*:\s*\{\s*type\s*:\s*['"]([a-z0-9-]+)['"]/gu))
    {
        tags.add(match[1].startsWith("sf-") ? match[1] : `sf-${match[1]}`);
    }
    return tags;
}

/**
 * options: packageRoot (holds src/smart/<folder>/rule.js), uiSource (a
 * ui-source checkout; its src/smart/<folder>/rule.js name the Framework's
 * rules). Returns warnings, one per component and missing rule.
 */
function undeclaredRelations({ packageRoot, uiSource })
{
    const frameworkRules = new Map();
    for (const folder of folders(uiSource))
    {
        const file = path.join(folder, "rule.js");
        if (!fs.existsSync(file)) continue;
        const rule = readRule(file);
        if (rule) for (const tag of rule.tags) frameworkRules.set(tag, rule.key);
    }

    const packageRules = [];
    for (const folder of folders(packageRoot))
    {
        const file = path.join(folder, "rule.js");
        if (!fs.existsSync(file)) continue;
        const rule = readRule(file);
        if (rule) packageRules.push({ folder, ...rule });
    }
    const packageTags = new Set(packageRules.flatMap((rule) => rule.tags));

    const warnings = [];
    for (const rule of packageRules)
    {
        const drawn = new Set();
        const ensured = new Set();
        for (const file of sources(rule.folder))
        {
            const source = fs.readFileSync(file, "utf8");
            for (const tag of drawnTags(source)) drawn.add(tag);
            for (const tag of ensuredTags(source)) ensured.add(tag);
        }
        const missing = new Map();
        for (const tag of drawn)
        {
            if (rule.tags.includes(tag) || packageTags.has(tag) || ensured.has(tag)) continue;
            const key = frameworkRules.get(tag);
            if (!key || rule.relations.has(key)) continue;
            if (!missing.has(key)) missing.set(key, []);
            missing.get(key).push(tag);
        }
        for (const [key, tags] of [...missing].sort(([a], [b]) => a.localeCompare(b)))
        {
            warnings.push(
                `${rule.key} draws <${tags.sort().join(">, <")}> without a relation to ${key}: `
                + `the element may upgrade before its styles arrive; add {name: '${key}'} to its rule's relation`,
            );
        }
    }
    return warnings;
}

module.exports = { undeclaredRelations, drawnTags, ensuredTags };
