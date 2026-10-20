"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fontverter = require("fontverter");

const {
    assertVariationAxesChangeOutlines,
    buildIconSubset,
    ligatureGlyphs,
    normalizeAxes,
    verifySubsetFont,
} = require("../../libs/iconSubset");

// Material Symbols Outlined (Apache-2.0, google/material-design-icons
// 50f0603134ce7b70b2d71b686cc13e8b57ccb74c, all four axes) cut with fontTools
// to the letters of "home" and "search" and every ligature they spell.
const VARIABLE_FONT = fs.readFileSync(
    path.join(__dirname, "fixtures/material-symbols-outlined-variable.woff2"),
);
const ICONS = ["home", "search"];
const AXES = { fill: [0, 1], weight: [100, 700] };

function tableRecords(truetype)
{
    const records = new Map();
    for (let index = 0; index < truetype.readUInt16BE(4); index += 1)
    {
        const record = 12 + index * 16;
        records.set(truetype.toString("latin1", record, record + 4), {
            length: truetype.readUInt32BE(record + 12),
            offset: truetype.readUInt32BE(record + 8),
        });
    }
    return records;
}

function table(truetype, tag)
{
    const record = tableRecords(truetype).get(tag);
    return record ? truetype.subarray(record.offset, record.offset + record.length) : null;
}

// Rewrites an sfnt without one table, as a subsetter that dropped it would.
function withoutTable(truetype, tag)
{
    const kept = [...tableRecords(truetype)].filter(([name]) => name !== tag);
    const header = Buffer.alloc(12 + kept.length * 16);
    truetype.copy(header, 0, 0, 12);
    header.writeUInt16BE(kept.length, 4);
    const chunks = [header];
    let offset = header.length;
    kept.forEach(([name, record], index) => {
        const data = Buffer.alloc(Math.ceil(record.length / 4) * 4);
        truetype.copy(data, 0, record.offset, record.offset + record.length);
        const entry = 12 + index * 16;
        header.write(name, entry, "latin1");
        header.writeUInt32BE(0, entry + 4);
        header.writeUInt32BE(offset, entry + 8);
        header.writeUInt32BE(record.length, entry + 12);
        chunks.push(data);
        offset += data.length;
    });
    return Buffer.concat(chunks);
}

test("a variable subset keeps gvar and every kept axis changes an outline", async () => {
    const result = await buildIconSubset({ axes: AXES, icons: ICONS, source: VARIABLE_FONT });
    const truetype = await fontverter.convert(result.font, "truetype");

    assert.ok(table(truetype, "fvar"), "the FILL and wght ranges keep fvar");
    assert.ok(table(truetype, "gvar"), "fvar without gvar would make the axes do nothing");
    await assertVariationAxesChangeOutlines(result.font, ICONS);
    assert.match(result.css, /font-weight: 100 700;/);
});

test("a subset that lost gvar is refused", async () => {
    const result = await buildIconSubset({ axes: AXES, icons: ICONS, source: VARIABLE_FONT });
    const truetype = await fontverter.convert(result.font, "truetype");
    const lost = withoutTable(truetype, "gvar");

    await assert.rejects(
        verifySubsetFont(lost, ICONS, normalizeAxes(AXES)),
        /declares the FILL, wght axes in fvar but lost its gvar table/,
    );
});

test("an axis that changes no outline fails the axis check", async () => {
    const result = await buildIconSubset({ axes: AXES, icons: ICONS, source: VARIABLE_FONT });
    const truetype = await fontverter.convert(result.font, "truetype");

    // FILL still swaps in the ".fill" glyphs through feature variations; the
    // weight axis has nothing left to interpolate.
    await assert.rejects(
        assertVariationAxesChangeOutlines(withoutTable(truetype, "gvar"), ICONS),
        /declares the wght axis \(100\.\.700\) but it changes no icon outline/,
    );
});

test("a name-based subset draws only the requested icons", async () => {
    const source = await fontverter.convert(VARIABLE_FONT, "truetype");
    const spellable = ligatureGlyphs(table(source, "GSUB")).size;
    assert.equal(spellable, 17, "the fixture letters spell 17 icons");

    const result = await buildIconSubset({ axes: AXES, icons: ICONS, source: VARIABLE_FONT });
    const truetype = await fontverter.convert(result.font, "truetype");
    assert.equal(result.drawnIcons, 2);
    assert.equal(ligatureGlyphs(table(truetype, "GSUB")).size, 2);
    assert.ok(result.font.length < VARIABLE_FONT.length / 2);

    await assert.rejects(
        verifySubsetFont(VARIABLE_FONT, ["home"]),
        /draws 17 icons for 1 requested names/,
    );
});
