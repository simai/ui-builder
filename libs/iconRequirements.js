"use strict";

const { parseFragment } = require("parse5");

const {
    normalizeAxes,
    normalizeFamily,
    normalizeIcons,
} = require("./iconSubset");

const MANIFEST_ICON_KEYS = new Set([
    "dynamic_icons",
    "icon_dependencies",
    "icons",
]);

function attributes(node)
{
    return Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
}

function textContent(node)
{
    if (node.nodeName === "#text") return node.value || "";
    return (node.childNodes || []).map(textContent).join("");
}

function familyFrom(attrs)
{
    const classes = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    if (classes.has("sf-icon-rounded")) return "rounded";
    if (classes.has("sf-icon-shape") || classes.has("sf-icon-sharp")) return "sharp";
    const declared = String(attrs.family || attrs.type || "outlined").toLowerCase();
    return normalizeFamily(declared === "shape" ? "sharp" : declared);
}

function iconRecord(rawRecord, defaultFamily = "outlined")
{
    if (typeof rawRecord === "string")
    {
        return { axes: normalizeAxes(), family: normalizeFamily(defaultFamily), name: rawRecord };
    }
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord))
    {
        throw new TypeError("Icon dependency must be a name or an object");
    }

    return {
        axes: normalizeAxes(rawRecord.axes || rawRecord),
        family: normalizeFamily(rawRecord.family || rawRecord.type || defaultFamily),
        name: rawRecord.name || rawRecord.icon,
    };
}

function htmlIconRecords(html)
{
    if (typeof html !== "string") throw new TypeError("HTML must be a string");
    const records = [];
    const visit = (node, embeddedDepth = 0) => {
        if (node.tagName)
        {
            const attrs = attributes(node);
            if (node.tagName === "iframe" && attrs.srcdoc)
            {
                if (embeddedDepth >= 8) throw new Error("Embedded HTML icon discovery is too deeply nested");
                visit(parseFragment(attrs.srcdoc), embeddedDepth + 1);
            }
            const classes = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
            if (node.tagName === "sf-icon" || classes.has("sf-icon"))
            {
                const name = String(
                    attrs.icon || attrs["data-icon"] || textContent(node),
                ).trim();
                if (name) records.push(iconRecord({
                    family: familyFrom(attrs),
                    fill: attrs.fill ?? (Object.prototype.hasOwnProperty.call(attrs, "filled") ? 1 : undefined),
                    grade: attrs.grade,
                    icon: name,
                    opticalSize: attrs["optical-size"] ?? attrs.opsz,
                    weight: attrs.weight,
                }));
            }
        }
        (node.childNodes || []).forEach(child => visit(child, embeddedDepth));
    };
    visit(parseFragment(html));
    return records;
}

function manifestIconRecords(manifests = [])
{
    if (!Array.isArray(manifests)) throw new TypeError("Manifests must be an array");
    const records = [];
    const visited = new WeakSet();
    const visit = (value, key = "") => {
        if (!value || typeof value !== "object") return;
        if (visited.has(value)) throw new Error("Component icon manifest contains a cycle");
        visited.add(value);
        if (Array.isArray(value))
        {
            if (MANIFEST_ICON_KEYS.has(key))
            {
                value.forEach(record => records.push(iconRecord(record)));
                return;
            }
            value.forEach(item => visit(item));
            return;
        }
        Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    };
    manifests.forEach(manifest => visit(manifest));
    return records;
}

function collectIconRequirements({ html = "", manifests = [] } = {})
{
    const byFamily = new Map();
    const records = [
        ...htmlIconRecords(html),
        ...manifestIconRecords(manifests),
    ];

    for (const record of records)
    {
        const name = normalizeIcons([record.name])[0];
        const family = normalizeFamily(record.family);
        if (!byFamily.has(family))
        {
            byFamily.set(family, {
                axes: { FILL: new Set(), GRAD: new Set(), opsz: new Set(), wght: new Set() },
                family,
                icons: new Set(),
            });
        }
        const requirement = byFamily.get(family);
        requirement.icons.add(name);
        Object.entries(record.axes).forEach(([axis, values]) => {
            values.forEach(value => requirement.axes[axis].add(value));
        });
    }

    return [...byFamily.values()]
        .sort((left, right) => left.family < right.family ? -1 : left.family > right.family ? 1 : 0)
        .map(requirement => ({
            axes: Object.fromEntries(Object.entries(requirement.axes).map(([axis, values]) => (
                [axis, [...values].sort((left, right) => left - right)]
            ))),
            family: requirement.family,
            icons: normalizeIcons([...requirement.icons]),
        }));
}

module.exports = {
    collectIconRequirements,
    htmlIconRecords,
    manifestIconRecords,
};
