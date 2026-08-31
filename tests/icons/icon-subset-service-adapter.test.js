"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
    buildLegacyIconSubsetResponse,
} = require("../../libs/iconSubsetServiceAdapter");

const fontRoot = path.dirname(require.resolve("@material-symbols/font-400/package.json"));
const source = fs.readFileSync(path.join(fontRoot, "material-symbols-outlined.woff2"));

test("legacy /ms/css adapter delegates to the canonical generator", async () => {
    const response = await buildLegacyIconSubsetResponse({
        publicBase: "/ms/font",
        query: new URLSearchParams({
            fill: "0",
            icon_names: "search,menu,search",
            type: "outlined",
            weight: "400",
        }),
        source,
        sourceRevision: "material-symbols-0.47.0",
    });

    assert.equal(response.headers["Content-Type"], "text/css; charset=utf-8");
    assert.match(response.headers["X-SIMAI-Font-Manifest"], /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(response.manifest.icons, ["menu", "search"]);
    assert.match(response.body, /\/ms\/font\/material-symbols-outlined\./);
    assert.ok(response.font.length > 0);
});
