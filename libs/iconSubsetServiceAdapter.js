"use strict";

const { buildIconSubset } = require("./iconSubset");

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

async function buildLegacyIconSubsetResponse(options = {})
{
    const query = options.query instanceof URLSearchParams
        ? options.query
        : new URLSearchParams(options.query || {});
    const packet = await buildIconSubset({
        axes: {
            FILL: query.get("fill") === "1" ? 1 : 0,
            GRAD: csv(query.get("grade") || "0"),
            opsz: csv(query.get("optical_size") || "24"),
            wght: csv(query.get("weight") || "400"),
        },
        family: query.get("type") || "outlined",
        generatorRevision: options.generatorRevision || null,
        icons: csv(query.get("icon_names")),
        license: options.license || "Apache-2.0",
        provenance: options.provenance || null,
        publicBase: options.publicBase || "/ms/font",
        source: options.source,
        sourceRevision: options.sourceRevision || null,
        sourceSha256: options.sourceSha256 || null,
    });

    return {
        body: packet.css,
        font: packet.font,
        headers: {
            "Content-Type": "text/css; charset=utf-8",
            "X-SIMAI-Font-Manifest": base64Url(packet.manifest),
        },
        manifest: packet.manifest,
    };
}

module.exports = { buildLegacyIconSubsetResponse };
