"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Ajv = require("ajv");

const {
    SCHEMA,
    buildIconSubset,
    canonicalJson,
    normalizeAxes,
    normalizeIcons,
} = require("../../libs/iconSubset");
const { collectIconRequirements } = require("../../libs/iconRequirements");

const FONT_ROOT = path.dirname(require.resolve("@material-symbols/font-400/package.json"));

function sourceFont(family = "outlined")
{
    return fs.readFileSync(path.join(FONT_ROOT, `material-symbols-${family}.woff2`));
}

test("normalization is deterministic and rejects invalid input", () => {
    assert.deepEqual(normalizeIcons(["search", "home", "search", ""]), ["home", "search"]);
    assert.deepEqual(normalizeAxes({ weight: [700, 400, 700] }), {
        FILL: [0],
        GRAD: [0],
        opsz: [24],
        wght: [400, 700],
    });
    assert.throws(() => normalizeIcons([]), /At least one icon/);
    assert.throws(() => normalizeIcons(["../home"]), /Invalid Material Symbols/);
    assert.throws(() => normalizeAxes({ fill: 2 }), /Invalid FILL axis/);
});

test("outlined subset is deterministic, content-addressed and schema-valid", async () => {
    const options = {
        family: "outlined",
        generatorRevision: "0123456789abcdef",
        icons: ["search", "home", "menu", "search"],
        provenance: "fixture/material-symbols-outlined.woff2",
        source: sourceFont(),
        sourceRevision: "material-symbols-0.47.0",
    };
    const first = await buildIconSubset(options);
    const second = await buildIconSubset({ ...options, icons: [...options.icons].reverse() });

    assert.deepEqual(second.font, first.font);
    assert.equal(second.css, first.css);
    assert.equal(second.manifestJson, first.manifestJson);
    assert.equal(first.manifest.schema, SCHEMA);
    assert.deepEqual(first.manifest.icons, ["home", "menu", "search"]);
    assert.equal(first.font.subarray(0, 4).toString("ascii"), "wOF2");
    assert.ok(first.font.length < sourceFont().length / 10);
    assert.ok(first.font.length > 1_628, "ligature glyph closure must be retained");
    assert.match(first.files.font, /^material-symbols-outlined\.[a-f0-9]{20}\.woff2$/);
    assert.match(first.css, /font-feature-settings: 'liga'/);
    assert.match(first.css, new RegExp(first.files.font.replaceAll(".", "\\.")));

    const schema = JSON.parse(fs.readFileSync(
        path.join(__dirname, "../../schemas/sf.icon_subset.v1.schema.json"),
        "utf8",
    ));
    const validate = new Ajv({ strict: false }).compile(schema);
    assert.equal(validate(first.manifest), true, JSON.stringify(validate.errors));

    const manifestBase = { ...first.manifest };
    delete manifestBase.packet_sha256;
    assert.equal(
        first.manifest.packet_sha256,
        crypto.createHash("sha256").update(canonicalJson(manifestBase)).digest("hex"),
    );
});

test("all public icon families receive distinct selectors and files", async () => {
    const results = {};
    for (const family of ["outlined", "rounded", "sharp"])
    {
        results[family] = await buildIconSubset({
            family,
            icons: ["home", "search"],
            source: sourceFont(family),
        });
    }

    assert.match(results.outlined.manifest.selector, /:not\(.sf-icon-rounded\)/);
    assert.equal(results.rounded.manifest.selector, ".sf-icon.sf-icon-rounded");
    assert.equal(results.sharp.manifest.selector, ".sf-icon.sf-icon-shape");
    assert.equal(new Set(Object.values(results).map(result => result.files.font)).size, 3);
});

test("source digest and non-default static axes fail closed", async () => {
    await assert.rejects(
        buildIconSubset({
            family: "outlined",
            icons: ["home"],
            source: sourceFont(),
            sourceSha256: "0".repeat(64),
        }),
        /SHA-256 does not match/,
    );
    await assert.rejects(
        buildIconSubset({
            axes: { weight: 700 },
            family: "outlined",
            icons: ["home"],
            source: sourceFont(),
        }),
        /axis does not exist/i,
    );
});

test("unknown ligature names fail before a packet is emitted", async () => {
    await assert.rejects(
        () => buildIconSubset({
            family: "outlined",
            icons: ["definitely_not_a_material_symbol"],
            source: sourceFont(),
        }),
        /Unknown Material Symbols icon name/,
    );
});

test("production discovery merges final HTML and component icon dependencies by family", () => {
    const requirements = collectIconRequirements({
        html: `
            <span class="sf-icon">menu</span>
            <sf-icon icon="search" weight="500"></sf-icon>
            <sf-icon class="sf-icon-rounded" icon="close" filled></sf-icon>
            <iframe srcdoc="&lt;span class=&quot;sf-icon&quot;&gt;download&lt;/span&gt;"></iframe>
        `,
        manifests: [{
            frontend: {
                dynamic_icons: [
                    { family: "sharp", name: "warning", weight: 600 },
                    "info",
                ],
            },
        }],
    });

    assert.deepEqual(requirements.map(({ family, icons }) => ({ family, icons })), [
        { family: "outlined", icons: ["download", "info", "menu", "search"] },
        { family: "rounded", icons: ["close"] },
        { family: "sharp", icons: ["warning"] },
    ]);
    assert.deepEqual(requirements[0].axes.wght, [400, 500]);
    assert.deepEqual(requirements[1].axes.FILL, [1]);
    assert.deepEqual(requirements[2].axes.wght, [600]);
});
