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

// ui-icons 0.2.0 names and ranges (ui-control evidence 2026-11-19-icons-axes).
const {
    ALIAS_SUNSET,
    legacyQueryAxes,
} = require("../../libs/iconSubsetServiceAdapter");
const fontverter = require("fontverter");
const harfbuzz = require("harfbuzzjs");

const VARIABLE_FONT = fs.readFileSync(
    path.join(__dirname, "fixtures/material-symbols-outlined-variable.woff2"),
);

async function fontAxes(woff2)
{
    const hb = await harfbuzz;
    const blob = hb.createBlob(Buffer.from(await fontverter.convert(woff2, "truetype")));
    const face = hb.createFace(blob, 0);
    try
    {
        return face.getAxisInfos();
    }
    finally
    {
        face.destroy();
        blob.destroy();
    }
}

test("the adapter reads grad and opsz values, lists and ranges, clamped", () => {
    const { axes, aliases } = legacyQueryAxes(new URLSearchParams("grad=-25..0&opsz=10..60&weight=400,500&fill=1"));
    assert.deepEqual(axes, { FILL: [0, 1], GRAD: [-25, 0], opsz: [20, 48], wght: [400, 500] });
    assert.deepEqual(aliases, []);
    assert.deepEqual(legacyQueryAxes(new URLSearchParams("")).axes, { FILL: [0], GRAD: [0], opsz: [24], wght: [400] });
    assert.deepEqual(legacyQueryAxes(new URLSearchParams("fill=only")).axes.FILL, [1]);
});

test("old names are aliases until 2027-01-01, widened to the page range; the new name wins", () => {
    assert.equal(ALIAS_SUNSET, "2027-01-01");
    const old = legacyQueryAxes(new URLSearchParams("grade=200&optical_size=40"));
    assert.deepEqual([old.axes.GRAD, old.axes.opsz], [[-25, 200], [20, 48]]);
    assert.deepEqual(old.aliases, ["grade", "optical_size"]);
    assert.deepEqual(legacyQueryAxes(new URLSearchParams("grade=500")).axes.GRAD, [-25, 200]);
    const both = legacyQueryAxes(new URLSearchParams("grade=200&grad=-25..0&optical_size=24&opsz=20..48"));
    assert.deepEqual([both.axes.GRAD, both.axes.opsz, both.aliases], [[-25, 0], [20, 48], []]);
});

test("grad and opsz ranges stay variable axes in the subset; old names give the same font", async () => {
    const ask = query => buildLegacyIconSubsetResponse({ query: new URLSearchParams(query), source: VARIABLE_FONT });
    const ranged = await ask("icon_names=home,search&type=outlined&weight=400&grad=-25..0&opsz=20..48");
    const axes = await fontAxes(ranged.font);
    assert.deepEqual([axes.GRAD?.min, axes.GRAD?.max], [-25, 0]);
    assert.deepEqual([axes.opsz?.min, axes.opsz?.max], [20, 48]);
    assert.match(ranged.body, /'GRAD' var\(--sf-icon--grade, 0\), 'opsz' var\(--sf-icon--optical-size, 24\)/);
    const aliased = await ask("icon_names=home,search&type=outlined&weight=400&grade=-25..0&optical_size=20..48");
    assert.ok(aliased.font.equals(ranged.font));
    const fixed = await ask("icon_names=home,search&type=outlined&weight=400&grad=0&opsz=24");
    assert.equal((await fontAxes(fixed.font)).GRAD, undefined);
    assert.ok(fixed.font.length < ranged.font.length);
});

test("a source without grad and opsz draws them at the default instead of refusing", async () => {
    const response = await buildLegacyIconSubsetResponse({
        query: new URLSearchParams("icon_names=menu,search&type=outlined&weight=400&grad=-25..0&opsz=20..48"),
        source,
    });
    assert.deepEqual(response.pinnedAxes.sort(), ["GRAD", "opsz"]);
    assert.deepEqual([response.manifest.axes.GRAD, response.manifest.axes.opsz], [[0], [24]]);
});
