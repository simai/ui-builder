"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

function run(script, argumentsList = [])
{
    return spawnSync(process.execPath, [path.join(ROOT, script), ...argumentsList], {
        cwd: ROOT,
        encoding: "utf8",
    });
}

test("repository contract binds the accepted frozen builder runtime", () => {
    const result = run("scripts/verify-repository-contract.cjs");

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);

    assert.equal(report.status, "PASS");
    assert.equal(report.webpack, "5.108.4");
    assert.equal(report.package_manager, "yarn@1.22.22");
});

test("frozen runtime invokes npm through the selected Node executable", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../../scripts/prepare-frozen-dependency-runtime.cjs"),
        "utf8",
    );

    assert.match(source, /const command = process\.execPath;/);
    assert.match(source, /spawnSync\(command, \[npmCli,/);
    assert.match(source, /path\.dirname\(process\.execPath\)/);
    assert.doesNotMatch(source, /spawnSync\((?:"npm"|command), \[\s*"exec"/);
});

test("tracked repository text follows the English and SIMAI brand policy", () => {
    const result = run("scripts/verify-english-surface.cjs");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /English and SIMAI brand surface check: PASS/);
});

test("removed modal target fails with an actionable compatibility message", () => {
    const result = run("scripts/legacy-command.cjs", ["modal"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /legacy 'modal' target was not present/);
});

test("product verifier rejects incomplete and relative invocations", () => {
    const missing = run("scripts/verify-product-reproducibility.cjs");
    const relative = run(
        "scripts/verify-product-reproducibility.cjs",
        ["../ui-loader", "output"],
    );
    const unknownOption = run(
        "scripts/verify-product-reproducibility.cjs",
        ["/tmp/ui-loader", "/tmp/output", "--unknown"],
    );

    assert.equal(missing.status, 2);
    assert.equal(relative.status, 2);
    assert.equal(unknownOption.status, 2);
    assert.match(missing.stderr, /usage:/);
    assert.match(relative.stderr, /usage:/);
    assert.match(unknownOption.stderr, /usage:/);
});

test("product verifier can require an explicit legacy compatibility binding", () => {
    const result = run(
        "scripts/verify-product-reproducibility.cjs",
        [
            "/tmp/ui-loader",
            "/tmp/output",
            "--require-legacy-compatibility",
        ],
    );

    assert.equal(result.status, 2);
    assert.match(
        result.stderr,
        /requires all SF_LEGACY_COMPATIBILITY_\* variables/,
    );
});

test("hosted product reproducibility has a bounded heap contract", () => {
    const workflow = fs.readFileSync(
        path.join(ROOT, ".github/workflows/product-reproducibility.yml"),
        "utf8",
    );

    assert.match(workflow, /NODE_OPTIONS: --max-old-space-size=4096/);
});
