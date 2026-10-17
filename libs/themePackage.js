"use strict";

// Theme packages (package.kind "theme"; docs/developer/architecture-sf-build.md,
// phase 3): a site's or a product's own colours, made the way the Framework
// makes its own. A theme package is a folder holding
//
//   framework.lock.json   the ui-source revision whose theme rules it uses
//   theme.json            the colour (or the generator's hue and chroma) and
//                         any palette it sets apart
//
// and the build is the Framework's own calculation at the pinned revision --
// ui-source src/core/js/theme-palette.js, the eight tonal palettes as the 128
// --sf-<palette>-<tone> primitives -- run twice and compared, then laid as
//
//   <out>/theme/theme.css     one rule of the primitives under the selector
//   <out>/theme/theme.json    the theme, every palette and tone
//   <out>/theme-receipt.json  what was built from what, with the files' digests
//
// Everything is read from git at one commit on each side, never from a
// working tree, as a component package is.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { SOURCE_LOCK, extractArchive, git, validateSourceLock } = require("./packageProduct");

const THEME_SOURCE = "theme.json";
const THEME_SOURCE_SCHEMA = "simai.framework.theme-source";
const RECEIPT_SCHEMA = "simai.framework.theme-receipt";
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const PALETTES = Object.freeze(["primary", "secondary", "tertiary", "neutral", "error", "warning", "success", "info"]);
// What the theme module of the pinned revision needs; nothing else of
// ui-source is read.
const FRAMEWORK_FILES = Object.freeze(["src/core/js/theme-palette.js", "src/core/js/vendor/material-color-utilities"]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const atPath = (packagePath, relative) => (packagePath ? `${packagePath}/${relative}` : relative);

/** The problems of a theme.json, empty when it holds. */
function themeSourceProblems(source)
{
    const problems = [];

    if (!source || typeof source !== "object" || Array.isArray(source))
    {
        return ["theme.json: not an object"];
    }

    if (source.schema !== THEME_SOURCE_SCHEMA || source.schema_version !== 1)
    {
        problems.push(`theme.json: schema ${THEME_SOURCE_SCHEMA} with schema_version 1`);
    }

    const byColor = source.color !== undefined;
    const byHct = source.hue !== undefined || source.chroma !== undefined;

    if (byColor === byHct)
    {
        problems.push("theme.json: a colour, or a hue and a chroma -- one of the two");
    }

    if (byColor && !(typeof source.color === "string" && HEX.test(source.color)))
    {
        problems.push("theme.json: color is #rgb or #rrggbb");
    }

    if (byHct && !(Number.isFinite(source.hue) && Number.isFinite(source.chroma) && source.chroma >= 0))
    {
        problems.push("theme.json: hue and chroma are numbers, chroma not below 0");
    }

    if (source.selector !== undefined && !(typeof source.selector === "string" && source.selector.trim()))
    {
        problems.push("theme.json: selector is a CSS selector");
    }

    for (const [name, rule] of Object.entries(source.palettes ?? {}))
    {
        if (!PALETTES.includes(name))
        {
            problems.push(`theme.json: palettes.${name} is not one of ${PALETTES.join(", ")}`);
            continue;
        }

        for (const key of Object.keys(rule ?? {}))
        {
            if (!["hue", "chroma"].includes(key) || !Number.isFinite(rule[key]))
            {
                problems.push(`theme.json: palettes.${name}.${key}: hue or chroma, a number`);
            }
        }
    }

    const known = ["schema", "schema_version", "color", "hue", "chroma", "selector", "palettes"];

    for (const key of Object.keys(source))
    {
        if (!known.includes(key))
        {
            problems.push(`theme.json: unknown property ${key}`);
        }
    }

    return problems;
}

/**
 * Build a theme package at a commit: {commit, sourceRevision, source, files}
 * where files maps the laid paths to their bytes. `workspace` is a directory
 * that holds the pinned Framework files while the build runs.
 */
async function buildThemePackage({ repositoryRoot, packagePath = "", revision = "HEAD", packageName, uiSourceRoot, workspace })
{
    const commit = git(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`]).trim();
    const read = (relative) => {
        try
        {
            return git(repositoryRoot, ["show", `${commit}:${atPath(packagePath, relative)}`]);
        }
        catch (error)
        {
            throw new Error(`${atPath(packagePath, relative)} is missing at ${commit.slice(0, 12)}`);
        }
    };

    const lock = validateSourceLock(JSON.parse(read(SOURCE_LOCK)), SOURCE_LOCK, packageName);
    const source = JSON.parse(read(THEME_SOURCE));
    const problems = themeSourceProblems(source);

    if (problems.length)
    {
        throw new Error(problems.join("; "));
    }

    const sourceRevision = lock.source.revision;
    git(uiSourceRoot, ["cat-file", "-e", `${sourceRevision}^{commit}`]);
    const frameworkRoot = fs.mkdtempSync(path.join(workspace || os.tmpdir(), "theme-framework-"));
    extractArchive(uiSourceRoot, sourceRevision, FRAMEWORK_FILES, frameworkRoot);

    const modulePath = path.join(frameworkRoot, "src/core/js/theme-palette.js");

    if (!fs.existsSync(modulePath))
    {
        throw new Error(`ui-source ${sourceRevision.slice(0, 12)} has no theme module (src/core/js/theme-palette.js); pin a revision that has`);
    }

    const palette = await import(pathToFileURL(modulePath).href);
    const selector = source.selector ?? ":root";
    const wave = () => {
        const theme = source.color !== undefined
            ? palette.themeFromColor(source.color, source.palettes ?? {})
            : palette.themeFromHct({ hue: source.hue, chroma: source.chroma }, source.palettes ?? {});

        return {
            "theme/theme.css": Buffer.from(palette.themeToCss(theme, selector)),
            "theme/theme.json": Buffer.from(`${JSON.stringify(theme, null, 2)}\n`),
        };
    };

    // Two waves, compared byte for byte, as every package is built.
    const first = wave();
    const second = wave();

    for (const name of Object.keys(first))
    {
        if (!first[name].equals(second[name]))
        {
            throw new Error(`the two waves differ in ${name}`);
        }
    }

    fs.rmSync(frameworkRoot, { force: true, recursive: true });

    return { commit, files: first, source, sourceRevision };
}

/** The receipt of a built theme package. */
function themeReceipt(built, { packageName, packagePath = "", repository = null, builderRevision = null })
{
    return {
        schema: RECEIPT_SCHEMA,
        schema_version: 1,
        package: packageName,
        kind: "theme",
        package_source: { repository, revision: built.commit, path: packagePath || "." },
        framework: { source: { repository: "simai/ui-source", revision: built.sourceRevision } },
        builder: { repository: "simai/ui-builder", revision: builderRevision },
        input: built.source,
        output: {
            files: Object.fromEntries(Object.entries(built.files)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])),
        },
    };
}

/** Lay a built theme and its receipt into `out`, which must be empty or new. */
function layThemePackage(out, built, receipt)
{
    fs.mkdirSync(out, { recursive: true });

    for (const [name, bytes] of Object.entries(built.files))
    {
        const destination = path.join(out, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes);
    }

    fs.writeFileSync(path.join(out, "theme-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

    return { css: path.join(out, "theme/theme.css"), receipt: path.join(out, "theme-receipt.json"), root: out };
}

module.exports = {
    RECEIPT_SCHEMA,
    THEME_SOURCE,
    THEME_SOURCE_SCHEMA,
    buildThemePackage,
    layThemePackage,
    themeReceipt,
    themeSourceProblems,
};
