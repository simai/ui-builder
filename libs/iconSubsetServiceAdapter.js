"use strict";

const { buildIconSubset } = require("./iconSubset");

// The /ms/css query as simai/ui-icons 0.2.0 reads it (icons.simai.io):
// weight (or wght), fill, grad, opsz. A value is one number, a list ("-25,0")
// or a range ("20..48"); a list or a range keeps the axis variable over its
// span, and a value past the Material Symbols design space is clamped to it.
// The SIMAI Framework asks for grad -25..0 and opsz 20..48 on every page.
//
// The old names grade, optical_size, optical-size and opticalsize are read as
// aliases until 2027-01-01, as the service reads them; the service's own name
// wins when a query carries both. An older Framework sent an old name only for
// one author's icon, so an alias value is widened to the page range (grade=200
// reads as grad -25..200): read as one point it would draw every icon of the
// page at that icon's grade.
const ALIAS_SUNSET = "2027-01-01";
const AXIS_PARAMS = Object.freeze({
    FILL: { name: "fill", aliases: [] },
    GRAD: { name: "grad", aliases: ["grade"] },
    opsz: { name: "opsz", aliases: ["optical_size", "optical-size", "opticalsize"] },
    wght: { name: "weight", aliases: [] },
});
const AXIS_BOUNDS = Object.freeze({
    FILL: [0, 1],
    GRAD: [-25, 200],
    opsz: [20, 48],
    wght: [100, 700],
});
const PAGE_RANGES = Object.freeze({
    GRAD: [-25, 0],
    opsz: [20, 48],
});
const AXIS_DEFAULTS = Object.freeze({ FILL: 0, GRAD: 0, opsz: 24, wght: 400 });

function csv(value)
{
    return String(value || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
}

function base64Url(value)
{
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function clamp(axis, value)
{
    const [min, max] = AXIS_BOUNDS[axis];
    return Math.max(min, Math.min(max, value));
}

// "400", "400,500", "20..48" -> the numbers named, clamped, unique, sorted.
function axisNumbers(axis, raw)
{
    const numbers = String(raw)
        .split(/,|\.\./u)
        .map(item => Number(item.trim()))
        .filter(Number.isFinite)
        .map(value => clamp(axis, value));
    return [...new Set(numbers)].sort((left, right) => left - right);
}

// Fill as the service reads it: 1 (or true, filled, mixed) keeps 0..1, so an
// outlined and a filled icon draw from one font; only (filled-only) is 1 alone.
function fillValues(raw)
{
    const value = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on", "filled", "both", "mixed"].includes(value)) return [0, 1];
    if (["only", "filled-only", "fill-only"].includes(value)) return [1];
    if (["0", "false", "no", "off", "outline", "outlined"].includes(value)) return [0];
    const numbers = axisNumbers("FILL", value);
    return numbers.length ? numbers : [0];
}

function readAxis(query, axis)
{
    const { name, aliases } = AXIS_PARAMS[axis];
    const own = query.get(name) ?? (axis === "wght" ? query.get("wght") : null);
    if (own != null && own !== "")
    {
        if (axis === "FILL") return { values: fillValues(own) };
        const values = axisNumbers(axis, own);
        if (values.length) return { values };
    }
    for (const alias of aliases)
    {
        const raw = query.get(alias);
        if (raw == null || raw === "") continue;
        const values = axisNumbers(axis, raw);
        if (!values.length) continue;
        const range = PAGE_RANGES[axis];
        return {
            alias,
            values: range
                ? [Math.min(range[0], ...values), Math.max(range[1], ...values)]
                : values,
        };
    }
    return { values: [AXIS_DEFAULTS[axis]] };
}

// The axes of a query, and the old names it used.
function legacyQueryAxes(query)
{
    const axes = {};
    const aliases = [];
    for (const axis of Object.keys(AXIS_PARAMS))
    {
        const read = readAxis(query, axis);
        axes[axis] = read.values;
        if (read.alias) aliases.push(read.alias);
    }
    return { aliases, axes };
}

const MISSING_AXIS = /^Requested (\w+) axis does not exist in the source font$/u;

async function buildLegacyIconSubsetResponse(options = {})
{
    const query = options.query instanceof URLSearchParams
        ? options.query
        : new URLSearchParams(options.query || {});
    const { aliases, axes } = legacyQueryAxes(query);
    const request = {
        axes,
        family: query.get("type") || "outlined",
        generatorRevision: options.generatorRevision || null,
        icons: csv(query.get("icon_names")),
        license: options.license || "Apache-2.0",
        provenance: options.provenance || null,
        publicBase: options.publicBase || "/ms/font",
        source: options.source,
        sourceRevision: options.sourceRevision || null,
        sourceSha256: options.sourceSha256 || null,
    };
    // A source without an axis (the static-weight @material-symbols fonts
    // keep FILL only) draws that axis at its default, as the service's older
    // static instances did, instead of refusing the request.
    const pinned = [];
    let packet;
    for (;;)
    {
        try
        {
            packet = await buildIconSubset(request);
            break;
        }
        catch (error)
        {
            const missing = MISSING_AXIS.exec(error?.message || "");
            if (!missing || pinned.includes(missing[1]) || !(missing[1] in AXIS_DEFAULTS)) throw error;
            pinned.push(missing[1]);
            request.axes = { ...request.axes, [missing[1]]: [AXIS_DEFAULTS[missing[1]]] };
        }
    }

    return {
        aliases,
        body: packet.css,
        font: packet.font,
        headers: {
            "Content-Type": "text/css; charset=utf-8",
            "X-SIMAI-Font-Manifest": base64Url(packet.manifest),
        },
        manifest: packet.manifest,
        pinnedAxes: pinned,
    };
}

module.exports = { ALIAS_SUNSET, buildLegacyIconSubsetResponse, legacyQueryAxes };
