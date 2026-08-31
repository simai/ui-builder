"use strict";

const crypto = require("node:crypto");

const subsetFont = require("subset-font");
const subsetFontVersion = require("subset-font/package.json").version;
const fontverter = require("fontverter");
const harfbuzz = require("harfbuzzjs");

const SCHEMA = "sf.icon_subset.v1";
const GENERATOR = `@simai/ui-builder/subset-font@${subsetFontVersion}`;
const MATERIAL_SYMBOL_FEATURES = Object.freeze(["rclt", "rlig"]);
const FAMILY_CONTRACTS = Object.freeze({
    outlined: {
        family: "Material Symbols Outlined",
        selector: ".sf-icon:not(.sf-icon-rounded):not(.sf-icon-shape)",
        slug: "material-symbols-outlined",
    },
    rounded: {
        family: "Material Symbols Rounded",
        selector: ".sf-icon.sf-icon-rounded",
        slug: "material-symbols-rounded",
    },
    sharp: {
        family: "Material Symbols Sharp",
        selector: ".sf-icon.sf-icon-shape",
        slug: "material-symbols-sharp",
    },
});
const AXIS_CONTRACTS = Object.freeze({
    FILL: { defaultValue: 0, max: 1, min: 0 },
    GRAD: { defaultValue: 0, max: 200, min: -50 },
    opsz: { defaultValue: 24, max: 48, min: 20 },
    wght: { defaultValue: 400, max: 700, min: 100 },
});

function sha256(value)
{
    return crypto.createHash("sha256").update(value).digest("hex");
}

function sortCodeUnits(values)
{
    return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }

    if (value && typeof value === "object" && !Buffer.isBuffer(value))
    {
        const output = {};
        for (const key of sortCodeUnits(Object.keys(value)))
        {
            output[key] = canonicalize(value[key]);
        }
        return output;
    }

    return value;
}

function canonicalJson(value)
{
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function normalizeFamily(value)
{
    const family = String(value || "outlined").trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FAMILY_CONTRACTS, family))
    {
        throw new Error(`Unsupported icon family: ${family || "<empty>"}`);
    }
    return family;
}

function normalizeIcons(values)
{
    if (!Array.isArray(values))
    {
        throw new TypeError("Icon names must be an array");
    }

    const icons = new Set();
    for (const rawValue of values)
    {
        const icon = String(rawValue || "").trim();
        if (!icon)
        {
            continue;
        }
        if (!/^[a-z0-9][a-z0-9_]*$/.test(icon))
        {
            throw new Error(`Invalid Material Symbols icon name: ${icon}`);
        }
        icons.add(icon);
    }

    if (!icons.size)
    {
        throw new Error("At least one icon name is required");
    }

    return sortCodeUnits(icons);
}

function normalizeAxisValues(name, rawValues)
{
    const contract = AXIS_CONTRACTS[name];
    const values = rawValues == null
        ? [contract.defaultValue]
        : Array.isArray(rawValues) ? rawValues : [rawValues];
    const normalized = new Set();

    for (const rawValue of values)
    {
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value < contract.min || value > contract.max)
        {
            throw new Error(
                `Invalid ${name} axis value ${rawValue}; expected ${contract.min}..${contract.max}`,
            );
        }
        normalized.add(value);
    }

    if (!normalized.size)
    {
        normalized.add(contract.defaultValue);
    }

    return [...normalized].sort((left, right) => left - right);
}

function normalizeAxes(rawAxes = {})
{
    return {
        FILL: normalizeAxisValues("FILL", rawAxes.FILL ?? rawAxes.fill),
        GRAD: normalizeAxisValues("GRAD", rawAxes.GRAD ?? rawAxes.grade),
        opsz: normalizeAxisValues(
            "opsz",
            rawAxes.opsz ?? rawAxes.opticalSize ?? rawAxes.optical_size,
        ),
        wght: normalizeAxisValues("wght", rawAxes.wght ?? rawAxes.weight),
    };
}

function subsetAxis(values, defaultValue)
{
    if (values.length === 1)
    {
        return values[0];
    }

    const min = values[0];
    const max = values[values.length - 1];
    return {
        default: Math.max(min, Math.min(max, defaultValue)),
        max,
        min,
    };
}

function subsetVariationAxes(axes)
{
    return {
        FILL: subsetAxis(axes.FILL, AXIS_CONTRACTS.FILL.defaultValue),
        GRAD: subsetAxis(axes.GRAD, AXIS_CONTRACTS.GRAD.defaultValue),
        opsz: subsetAxis(axes.opsz, AXIS_CONTRACTS.opsz.defaultValue),
        wght: subsetAxis(axes.wght, AXIS_CONTRACTS.wght.defaultValue),
    };
}

function isDefaultStaticAxes(axes)
{
    return Object.entries(AXIS_CONTRACTS).every(([name, contract]) => (
        axes[name].length === 1 && axes[name][0] === contract.defaultValue
    ));
}

function cssAxisRange(values)
{
    return values.length === 1 ? String(values[0]) : `${values[0]} ${values.at(-1)}`;
}

function buildCss({ axes, contract, fontFamily, fontUrl })
{
    return `@font-face {\n`
        + `  font-family: '${fontFamily}';\n`
        + `  src: url('${fontUrl}') format('woff2');\n`
        + `  font-style: normal;\n`
        + `  font-weight: ${cssAxisRange(axes.wght)};\n`
        + `  font-display: block;\n`
        + `}\n\n`
        + `${contract.selector} {\n`
        + `  --sf-icon--font-family: '${fontFamily}';\n`
        + `  font-family: '${fontFamily}';\n`
        + `  font-feature-settings: 'liga';\n`
        + `  font-variation-settings: `
        + `'FILL' var(--sf-icon--fill, ${axes.FILL[0]}), `
        + `'wght' var(--sf-icon--weight, ${axes.wght[0]}), `
        + `'GRAD' var(--sf-icon--grade, ${axes.GRAD[0]}), `
        + `'opsz' var(--sf-icon--optical-size, ${axes.opsz[0]});\n`
        + `}\n`;
}

async function validateLigatures(source, icons)
{
    const [hb, truetype] = await Promise.all([
        harfbuzz,
        fontverter.convert(source, "truetype"),
    ]);
    const blob = hb.createBlob(truetype);
    const face = hb.createFace(blob, 0);
    const font = hb.createFont(face);
    try
    {
        for (const icon of icons)
        {
            const buffer = hb.createBuffer();
            try
            {
                buffer.addText(icon);
                buffer.guessSegmentProperties();
                hb.shape(font, buffer);
                const glyphs = buffer.json(font);
                if (glyphs.length !== 1 || !Number.isInteger(glyphs[0]?.g) || glyphs[0].g === 0)
                {
                    throw new Error(`Unknown Material Symbols icon name: ${icon}`);
                }
            }
            finally
            {
                buffer.destroy();
            }
        }
    }
    finally
    {
        font.destroy();
        face.destroy();
        blob.destroy();
    }
}

async function buildIconSubset(options = {})
{
    const source = Buffer.isBuffer(options.source)
        ? options.source
        : Buffer.from(options.source || []);
    if (!source.length)
    {
        throw new Error("A non-empty source font is required");
    }

    const sourceSha256 = sha256(source);
    if (options.sourceSha256 && options.sourceSha256 !== sourceSha256)
    {
        throw new Error("Source font SHA-256 does not match the requested digest");
    }

    const family = normalizeFamily(options.family);
    const contract = FAMILY_CONTRACTS[family];
    const icons = normalizeIcons(options.icons);
    await validateLigatures(source, icons);
    const axes = normalizeAxes(options.axes);
    const iconText = icons.join("\n");
    let font;
    try
    {
        font = await subsetFont(source, iconText, {
            keepFeatures: MATERIAL_SYMBOL_FEATURES,
            targetFormat: "woff2",
            variationAxes: subsetVariationAxes(axes),
        });
    }
    catch (error)
    {
        const missingAxis = /axis does not exist/i.test(String(error && error.message));
        if (!missingAxis || !isDefaultStaticAxes(axes))
        {
            throw error;
        }
        font = await subsetFont(source, iconText, {
            keepFeatures: MATERIAL_SYMBOL_FEATURES,
            targetFormat: "woff2",
        });
    }
    await validateLigatures(font, icons);
    const fontSha256 = sha256(font);
    const fileStem = `${contract.slug}.${fontSha256.slice(0, 20)}`;
    const fontFile = `${fileStem}.woff2`;
    const cssFile = `${fileStem}.css`;
    const manifestFile = `${fileStem}.manifest.json`;
    const publicBase = String(options.publicBase || "./").replace(/\/+$/, "");
    const fontUrl = `${publicBase || "."}/${fontFile}`;
    const fontFamily = `${contract.family} Subset ${fontSha256.slice(0, 12)}`;
    const css = buildCss({ axes, contract, fontFamily, fontUrl });
    const manifestBase = {
        axes,
        family,
        files: {
            css: { path: cssFile, sha256: sha256(css) },
            font: { path: fontFile, sha256: fontSha256, size: font.length },
        },
        font_family: fontFamily,
        generator: {
            id: GENERATOR,
            revision: options.generatorRevision || null,
        },
        icons,
        license: options.license || "Apache-2.0",
        provenance: options.provenance || null,
        schema: SCHEMA,
        selector: contract.selector,
        source: {
            revision: options.sourceRevision || null,
            sha256: sourceSha256,
        },
    };
    const packetSha256 = sha256(canonicalJson(manifestBase));
    const manifest = { ...manifestBase, packet_sha256: packetSha256 };

    return {
        css,
        files: { css: cssFile, font: fontFile, manifest: manifestFile },
        font,
        manifest,
        manifestJson: canonicalJson(manifest),
    };
}

module.exports = {
    FAMILY_CONTRACTS,
    GENERATOR,
    SCHEMA,
    buildIconSubset,
    canonicalJson,
    normalizeAxes,
    normalizeFamily,
    normalizeIcons,
    sha256,
};
