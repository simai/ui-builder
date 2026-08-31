"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FONT_ROOT = path.dirname(require.resolve("@material-symbols/font-400/package.json"));
const CLI = path.join(__dirname, "../../bin/sf-icons.js");

function run(outputRoot)
{
    return childProcess.spawnSync(process.execPath, [
        CLI,
        "build",
        "--font", path.join(FONT_ROOT, "material-symbols-outlined.woff2"),
        "--icons", "search,home,search",
        "--out", outputRoot,
        "--source-revision", "material-symbols-0.47.0",
        "--generator-revision", "fixture",
    ], { encoding: "utf8" });
}

test("CLI writes one immutable packet and is idempotent", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-icons-cli-"));
    try
    {
        const first = run(workspace);
        assert.equal(first.status, 0, first.stderr);
        const result = JSON.parse(first.stdout);
        assert.deepEqual(fs.readdirSync(workspace).sort(), Object.values(result.files).sort());

        const second = run(workspace);
        assert.equal(second.status, 0, second.stderr);

        fs.writeFileSync(path.join(workspace, result.files.css), "changed");
        const changed = run(workspace);
        assert.notEqual(changed.status, 0);
        assert.match(changed.stderr, /Refusing to overwrite changed output/);
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});

test("CLI discovers one family from final HTML and component manifests", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-icons-plan-"));
    const output = path.join(workspace, "output");
    const html = path.join(workspace, "page.html");
    const manifest = path.join(workspace, "component.json");
    try
    {
        fs.writeFileSync(html, '<sf-icon icon="search"></sf-icon><span class="sf-icon">menu</span>');
        fs.writeFileSync(manifest, JSON.stringify({ icon_dependencies: ["close"] }));
        const result = childProcess.spawnSync(process.execPath, [
            CLI,
            "build",
            "--font", path.join(FONT_ROOT, "material-symbols-outlined.woff2"),
            "--html", html,
            "--manifests", manifest,
            "--out", output,
        ], { encoding: "utf8" });

        assert.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.deepEqual(payload.manifest.icons, ["close", "menu", "search"]);
    }
    finally
    {
        fs.rmSync(workspace, { force: true, recursive: true });
    }
});
