"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const fontverter = require("fontverter");
const harfbuzz = require("harfbuzzjs");
const harfbuzzVersion = require("harfbuzzjs/package.json").version;

const SCHEMA = "sf.icon_subset.v1";
const GENERATOR = `@simai/ui-builder/hb-subset@${harfbuzzVersion}`;
const MATERIAL_SYMBOL_FEATURES = Object.freeze(["rclt", "rlig"]);
const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;
const HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE = 0x200;
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

function isDefaultStaticAxis(name, values)
{
    return values.length === 1 && values[0] === AXIS_CONTRACTS[name].defaultValue;
}

// The HarfBuzz instancing request for the axes the source font declares. An
// axis kept over the source's whole range is left alone: instancing it would
// change nothing, and HarfBuzz's gvar instancer is where variation data gets
// lost on large glyph sets.
function subsetAxisRequest(fontAxes, axes)
{
    const requested = subsetVariationAxes(axes);
    const request = {};
    for (const name of sortCodeUnits(Object.keys(requested)))
    {
        const sourceAxis = fontAxes[name];
        if (!sourceAxis)
        {
            if (!isDefaultStaticAxis(name, axes[name]))
            {
                throw new Error(`Requested ${name} axis does not exist in the source font`);
            }
            continue;
        }
        const value = requested[name];
        if (typeof value === "object"
            && value.min === sourceAxis.min
            && value.max === sourceAxis.max
            && value.default === sourceAxis.default)
        {
            continue;
        }
        request[name] = value;
    }
    return request;
}

// Every point in the requested design space: the source default plus each
// combination of requested axis values the font declares. Shaping at these
// points finds the ligature glyphs and the glyphs that feature variations
// swap in (Material Symbols draws FILL 1 with separate ".fill" glyphs).
function axisLocations(fontAxes, axes)
{
    let locations = [{}];
    for (const name of sortCodeUnits(Object.keys(axes)))
    {
        if (!fontAxes[name])
        {
            continue;
        }
        locations = locations.flatMap(location => axes[name].map(value => ({
            ...location,
            [name]: value,
        })));
    }
    return Object.keys(locations[0]).length ? [{}, ...locations] : locations;
}

function hbTag(name)
{
    return [...name].reduce((tag, character) => ((tag << 8) | character.charCodeAt(0)) >>> 0, 0);
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

function openFont(hb, truetype)
{
    const blob = hb.createBlob(truetype);
    const face = hb.createFace(blob, 0);
    const font = hb.createFont(face);
    return {
        face,
        font,
        destroy()
        {
            font.destroy();
            face.destroy();
            blob.destroy();
        },
    };
}

function shapeIcon(hb, font, icon)
{
    const buffer = hb.createBuffer();
    try
    {
        buffer.addText(icon);
        buffer.guessSegmentProperties();
        hb.shape(font, buffer);
        const glyphs = buffer.json(font);
        return glyphs.length === 1 && Number.isInteger(glyphs[0]?.g) ? glyphs[0].g : 0;
    }
    finally
    {
        buffer.destroy();
    }
}

// Shapes every icon at every location and returns the glyphs it draws there.
function shapeIconGlyphs(hb, font, icons, locations, failure)
{
    const glyphs = new Set();
    for (const location of locations)
    {
        font.setVariations(location);
        for (const icon of icons)
        {
            const glyph = shapeIcon(hb, font, icon);
            if (glyph === 0)
            {
                throw new Error(`${failure}: ${icon}`);
            }
            glyphs.add(glyph);
        }
    }
    return glyphs;
}

function tableBytes(face, tag)
{
    const view = face.reference_table(tag);
    return view ? Buffer.from(view) : null;
}

// Distinct glyphs that GSUB ligature substitutions (lookup type 4, directly
// or through a type 7 extension) produce: the icons a font can draw by name.
function ligatureGlyphs(gsub)
{
    const glyphs = new Set();
    if (!gsub || gsub.length < 10)
    {
        return glyphs;
    }
    const lookupList = gsub.readUInt16BE(8);
    const lookupCount = gsub.readUInt16BE(lookupList);
    for (let lookupIndex = 0; lookupIndex < lookupCount; lookupIndex += 1)
    {
        const lookup = lookupList + gsub.readUInt16BE(lookupList + 2 + lookupIndex * 2);
        const lookupType = gsub.readUInt16BE(lookup);
        const subtableCount = gsub.readUInt16BE(lookup + 4);
        for (let subtableIndex = 0; subtableIndex < subtableCount; subtableIndex += 1)
        {
            let subtable = lookup + gsub.readUInt16BE(lookup + 6 + subtableIndex * 2);
            let subtableType = lookupType;
            if (subtableType === 7)
            {
                subtableType = gsub.readUInt16BE(subtable + 2);
                subtable += gsub.readUInt32BE(subtable + 4);
            }
            if (subtableType !== 4)
            {
                continue;
            }
            const setCount = gsub.readUInt16BE(subtable + 4);
            for (let setIndex = 0; setIndex < setCount; setIndex += 1)
            {
                const ligatureSet = subtable + gsub.readUInt16BE(subtable + 6 + setIndex * 2);
                const ligatureCount = gsub.readUInt16BE(ligatureSet);
                for (let index = 0; index < ligatureCount; index += 1)
                {
                    const ligature = ligatureSet + gsub.readUInt16BE(ligatureSet + 2 + index * 2);
                    glyphs.add(gsub.readUInt16BE(ligature));
                }
            }
        }
    }
    return glyphs;
}

function assertAxisChangesOutlines(hb, opened, icons, axis, fontAxes)
{
    const defaults = Object.fromEntries(
        Object.entries(fontAxes).map(([name, info]) => [name, info.default]),
    );
    const { max, min } = fontAxes[axis];
    for (const icon of icons)
    {
        const outlines = [min, max].map(value => {
            opened.font.setVariations({ ...defaults, [axis]: value });
            return opened.font.glyphToPath(shapeIcon(hb, opened.font, icon));
        });
        if (outlines[0] !== outlines[1])
        {
            return;
        }
    }
    throw new Error(
        `Subset font declares the ${axis} axis (${min}..${max}) but it changes no icon outline`,
    );
}

/**
 * Checks that every declared variation axis changes at least one icon outline
 * between its minimum and maximum.
 */
async function assertVariationAxesChangeOutlines(font, icons)
{
    const [hb, truetype] = await Promise.all([harfbuzz, fontverter.convert(font, "truetype")]);
    const opened = openFont(hb, truetype);
    try
    {
        const fontAxes = opened.face.getAxisInfos();
        for (const axis of sortCodeUnits(Object.keys(fontAxes)))
        {
            assertAxisChangesOutlines(hb, opened, icons, axis, fontAxes);
        }
    }
    finally
    {
        opened.destroy();
    }
}

/**
 * Accepts an emitted subset only when it is what was asked for: variation
 * axes keep their gvar data and change outlines, every icon still shapes to
 * one glyph across the requested design space, and the font draws no icon
 * beyond the requested ones. Returns the number of icons the font draws.
 */
async function verifySubsetFont(font, icons, axes = normalizeAxes())
{
    const [hb, truetype] = await Promise.all([harfbuzz, fontverter.convert(font, "truetype")]);
    const opened = openFont(hb, truetype);
    try
    {
        const fontAxes = opened.face.getAxisInfos();
        const axisNames = sortCodeUnits(Object.keys(fontAxes));
        if (axisNames.length && !tableBytes(opened.face, "gvar") && !tableBytes(opened.face, "CFF2"))
        {
            throw new Error(
                `Subset font declares the ${axisNames.join(", ")} axes in fvar but lost its gvar `
                + "table, so the axes would do nothing; request fewer icons or pin every axis",
            );
        }
        shapeIconGlyphs(
            hb,
            opened.font,
            icons,
            axisLocations(fontAxes, axes),
            "Subset font does not draw the requested icon",
        );
        for (const axis of axisNames)
        {
            assertAxisChangesOutlines(hb, opened, icons, axis, fontAxes);
        }
        const drawnIcons = ligatureGlyphs(tableBytes(opened.face, "GSUB")).size;
        if (drawnIcons > icons.length)
        {
            throw new Error(
                `Subset font draws ${drawnIcons} icons for ${icons.length} requested names`,
            );
        }
        return drawnIcons;
    }
    finally
    {
        opened.destroy();
    }
}

let subsetRuntime;

function loadSubsetRuntime()
{
    subsetRuntime ??= WebAssembly.instantiate(
        fs.readFileSync(require.resolve("harfbuzzjs/hb-subset.wasm")),
    ).then(({ instance }) => instance.exports);
    return subsetRuntime;
}

async function subsetTruetype(truetype, { axes = {}, closure, glyphs = [], unicodes })
{
    const wasm = await loadSubsetRuntime();
    const input = wasm.hb_subset_input_create_or_fail();
    if (!input)
    {
        throw new Error("HarfBuzz could not create a subset input");
    }
    const fontPointer = wasm.malloc(truetype.length);
    new Uint8Array(wasm.memory.buffer).set(truetype, fontPointer);
    const blob = wasm.hb_blob_create(fontPointer, truetype.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
    const face = wasm.hb_face_create(blob, 0);
    wasm.hb_blob_destroy(blob);
    let subset = 0;
    try
    {
        const features = wasm.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
        wasm.hb_set_clear(features);
        for (const feature of MATERIAL_SYMBOL_FEATURES)
        {
            wasm.hb_set_add(features, hbTag(feature));
        }
        const unicodeSet = wasm.hb_subset_input_unicode_set(input);
        for (const unicode of unicodes)
        {
            wasm.hb_set_add(unicodeSet, unicode);
        }
        const glyphSet = wasm.hb_subset_input_glyph_set(input);
        for (const glyph of glyphs)
        {
            wasm.hb_set_add(glyphSet, glyph);
        }
        if (!closure)
        {
            wasm.hb_subset_input_set_flags(
                input,
                wasm.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE,
            );
        }
        for (const [name, value] of Object.entries(axes))
        {
            const accepted = typeof value === "number"
                ? wasm.hb_subset_input_pin_axis_location(input, face, hbTag(name), value)
                : wasm.hb_subset_input_set_axis_range(
                    input,
                    face,
                    hbTag(name),
                    value.min,
                    value.max,
                    value.default,
                );
            if (!accepted)
            {
                throw new Error(`HarfBuzz rejected the ${name} axis request`);
            }
        }
        subset = wasm.hb_subset_or_fail(face, input);
        if (!subset)
        {
            throw new Error("HarfBuzz could not subset the source font");
        }
        const result = wasm.hb_face_reference_blob(subset);
        const offset = wasm.hb_blob_get_data(result, 0);
        const length = wasm.hb_blob_get_length(result);
        const bytes = Buffer.from(new Uint8Array(wasm.memory.buffer, offset, length));
        wasm.hb_blob_destroy(result);
        if (!length)
        {
            throw new Error("HarfBuzz produced an empty subset font");
        }
        return bytes;
    }
    finally
    {
        if (subset)
        {
            wasm.hb_face_destroy(subset);
        }
        wasm.hb_subset_input_destroy(input);
        wasm.hb_face_destroy(face);
        wasm.free(fontPointer);
    }
}

async function subsetIconFont(source, icons, axes)
{
    const [hb, truetype] = await Promise.all([harfbuzz, fontverter.convert(source, "truetype")]);
    const opened = openFont(hb, truetype);
    let glyphs;
    let request;
    try
    {
        const fontAxes = opened.face.getAxisInfos();
        request = subsetAxisRequest(fontAxes, axes);
        glyphs = shapeIconGlyphs(
            hb,
            opened.font,
            icons,
            axisLocations(fontAxes, axes),
            "Unknown Material Symbols icon name",
        );
    }
    finally
    {
        opened.destroy();
    }
    const unicodes = new Set([...icons.join("")].map(character => character.codePointAt(0)));
    // First by glyph id with layout closure off. Subsetting by name with
    // closure keeps every ligature spelled with the kept letters (78 names drew
    // 3,465 icons); here only the requested icons' glyphs, the letters that
    // spell them and the ligature entries joining the two survive. Instancing
    // then runs on that small font, with closure on so that pinned axes bake
    // their feature variations in. The HarfBuzz WASM heap is fixed at 65 MiB;
    // a large instanced glyph set still loses gvar, which verifySubsetFont
    // refuses.
    let subset = await subsetTruetype(truetype, { glyphs, unicodes });
    if (Object.keys(request).length)
    {
        subset = await subsetTruetype(subset, { axes: request, closure: true, unicodes });
    }
    return fontverter.convert(subset, "woff2", "truetype");
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
    const axes = normalizeAxes(options.axes);
    const font = await subsetIconFont(source, icons, axes);
    const drawnIcons = await verifySubsetFont(font, icons, axes);
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
        drawnIcons,
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
    assertVariationAxesChangeOutlines,
    buildIconSubset,
    canonicalJson,
    ligatureGlyphs,
    normalizeAxes,
    normalizeFamily,
    normalizeIcons,
    sha256,
    verifySubsetFont,
};
