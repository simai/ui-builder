"use strict";

// Theme packages (package.kind "theme"): a folder with framework.lock.json and
// theme.json is built with the Framework's own calculation at the pinned
// ui-source revision, twice, and laid as theme/theme.css, theme/theme.json
// and theme-receipt.json.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const api = require("../../libs/api");
const { themeSourceProblems } = require("../../libs/themePackage");

const UI_SOURCE = process.env.SF_BUILD_UI_SOURCE || path.resolve(__dirname, "../../../ui-source");
// The first ui-source revision with core/js/theme-palette.js (ui-45384c434d3f).
const THEME_REVISION = "b06420f5f379";

const git = (cwd, ...args) => {
    const run = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
};

function themeRepository(theme)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "theme-package-"));
    const revision = git(UI_SOURCE, "rev-parse", `${THEME_REVISION}^{commit}`);
    git(root, "init", "-q");
    git(root, "config", "user.email", "probe@example.invalid");
    git(root, "config", "user.name", "probe");
    fs.mkdirSync(path.join(root, "theme"));
    fs.writeFileSync(path.join(root, "theme/framework.lock.json"), JSON.stringify({
        schema: "simai.framework.product-package-source-lock.v1",
        source: { repository: "simai/ui-source", revision },
    }));
    fs.writeFileSync(path.join(root, "theme/theme.json"), JSON.stringify(theme));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "theme");
    return root;
}

const haveSource = fs.existsSync(path.join(UI_SOURCE, ".git"))
    && spawnSync("git", ["cat-file", "-e", `${THEME_REVISION}^{commit}`], { cwd: UI_SOURCE }).status === 0;

test("theme.json is checked before anything is built", () => {
    assert.deepEqual(themeSourceProblems({ schema: "simai.framework.theme-source", schema_version: 1, color: "#2e7d32" }), []);
    assert.ok(themeSourceProblems({ schema: "simai.framework.theme-source", schema_version: 1 }).length);
    assert.ok(themeSourceProblems({ schema: "simai.framework.theme-source", schema_version: 1, color: "green" }).length);
    assert.ok(themeSourceProblems({ schema: "simai.framework.theme-source", schema_version: 1, color: "#2e7d32", hue: 1, chroma: 2 }).length);
    assert.ok(themeSourceProblems({ schema: "simai.framework.theme-source", schema_version: 1, color: "#2e7d32", palettes: { brand: {} } }).length);
});

test("a theme package is built from its colour and laid with its receipt", { skip: !haveSource && "ui-source with the theme module is not checked out beside the builder" }, async () => {
    const root = themeRepository({ schema: "simai.framework.theme-source", schema_version: 1, color: "#2e7d32", selector: ".site" });
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "theme-out-")), "out");
    const result = await api.buildPackage({ name: "acme-theme", kind: "theme", packageRoot: path.join(root, "theme"), uiSource: UI_SOURCE, out });
    assert.equal(result.status, "PASS", JSON.stringify(result.error));
    const css = fs.readFileSync(path.join(out, "theme/theme.css"), "utf8");
    assert.match(css, /^\.site \{\n/u);
    assert.equal((css.match(/--sf-[a-z]+-\d+: #[0-9a-f]{6};/gu) || []).length, 128);
    const receipt = JSON.parse(fs.readFileSync(path.join(out, "theme-receipt.json"), "utf8"));
    assert.equal(receipt.schema, "simai.framework.theme-receipt");
    assert.equal(receipt.kind, "theme");
    assert.equal(receipt.output.files["theme/theme.css"].sha256, crypto.createHash("sha256").update(css).digest("hex"));
});

test("the Framework's own colour builds the Framework's own primitives", { skip: !haveSource && "ui-source not checked out beside the builder" }, async () => {
    const root = themeRepository({ schema: "simai.framework.theme-source", schema_version: 1, hue: 265, chroma: 85 });
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "theme-out-")), "out");
    const result = await api.buildPackage({ name: "plain", kind: "theme", packageRoot: path.join(root, "theme"), uiSource: UI_SOURCE, out });
    assert.equal(result.status, "PASS", JSON.stringify(result.error));
    assert.match(fs.readFileSync(path.join(out, "theme/theme.css"), "utf8"), /--sf-primary-40: #005bbe;/u);
});
