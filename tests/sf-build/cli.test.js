"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { USAGE, main, parseArguments } = require("../../bin/sf-build");

const CLI = path.resolve(__dirname, "../../bin/sf-build.js");

function sfBuild(args, options = {})
{
    return spawnSync(process.execPath, [CLI, ...args], { cwd: options.cwd, encoding: "utf8", env: { ...process.env, ...options.env } });
}

function capture()
{
    const stdout = [];
    const stderr = [];

    return {
        io: { stderr: { write: value => stderr.push(value) }, stdout: { write: value => stdout.push(value) } },
        stderr: () => stderr.join(""),
        stdout: () => stdout.join(""),
    };
}

test("the commands and their options parse, in both --flag value and --flag=value forms", () => {
    assert.deepEqual(parseArguments(["package", "--name", "acme", "--out=dist/ui", "--replace-out", "--json"]), {
        command: "package",
        json: true,
        options: { name: "acme", out: "dist/ui", replaceOut: true },
        target: undefined,
    });
    assert.deepEqual(parseArguments(["verify", "framework", "--ui-source", "/src"]).target, "framework");
    assert.deepEqual(parseArguments(["receipt", "--report", "/w/report.json", "--ui", "/ui"]).options, { report: "/w/report.json", ui: "/ui" });
    assert.deepEqual(parseArguments([]), { command: "help" });
    assert.deepEqual(parseArguments(["package", "--help"]), { command: "help" });
    assert.deepEqual(parseArguments(["--version"]), { command: "version" });
});

test("a malformed command line is a usage error naming what is wrong", () => {
    const cases = [
        [["build"], /unknown command build/u],
        [["verify"], /verify needs a target/u],
        [["verify", "theme"], /verify needs a target/u],
        [["package", "--nme", "acme"], /unknown option --nme/u],
        [["package", "--name"], /--name needs a value/u],
        [["package", "--name", "--json"], /--name needs a value/u],
        [["package", "--name", "a", "--name", "b"], /--name is given twice/u],
        [["package", "--json=yes"], /--json takes no value/u],
        [["package", "extra"], /unexpected argument extra/u],
        [["receipt", "--name", "acme"], /receipt does not take --name/u],
        [["framework", "--package-root", "/p"], /framework does not take --package-root/u],
        [["verify", "package", "--out", "/o"], /verify package does not take --out/u],
    ];

    for (const [argv, message] of cases)
    {
        assert.throws(() => parseArguments(argv), error => error.code === "USAGE" && message.test(error.message), argv.join(" "));
    }
});

test("--help prints the usage text; a usage error exits 2, as text or as JSON", async () => {
    const help = sfBuild(["--help"]);
    assert.equal(help.status, 0);
    assert.equal(help.stdout, USAGE);
    assert.match(help.stdout, /sf-build package {3}\[options\]/u);
    assert.match(help.stdout, /Exit codes:/u);

    const text = sfBuild(["package", "--bogus"]);
    assert.equal(text.status, 2);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /unknown option --bogus/u);

    const json = sfBuild(["package", "--bogus", "--json"]);
    assert.equal(json.status, 2);
    const result = JSON.parse(json.stdout);
    assert.equal(result.schema, "simai.sf-build.result.v1");
    assert.equal(result.status, "FAIL");
    assert.equal(result.exit_code, 2);
    assert.equal(result.error.code, "USAGE");

    const version = capture();
    assert.equal(await main(["--version"], version.io), 0);
    assert.match(version.stdout(), /^@simai\/ui-builder \d+\.\d+\.\d+\n$/u);
});

test("missing inputs are usage errors reported before anything is built", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sf-build-cli-"));

    try
    {
        const env = { SF_BUILD_UI: "", SF_BUILD_UI_SOURCE: "" };
        const noName = JSON.parse(sfBuild(["package", "--json"], { cwd: empty, env }).stdout);
        assert.equal(noName.error.code, "USAGE");
        assert.match(noName.error.message, /package name/u);

        const noSource = JSON.parse(sfBuild(["package", "--json", "--name", "acme", "--package-root", "."], { cwd: empty, env }).stdout);
        assert.match(noSource.error.message, /ui-source checkout/u);

        const noOut = JSON.parse(sfBuild(["package", "--json", "--name", "acme", "--package-root", ".", "--ui-source", "."], { cwd: empty, env }).stdout);
        assert.match(noOut.error.message, /give --out .* or --workspace/u);

        const kind = sfBuild(["package", "--json", "--name", "acme", "--kind", "theme", "--package-root", ".", "--ui-source", ".", "--out", "o"], { cwd: empty, env });
        assert.equal(kind.status, 2);
        assert.equal(JSON.parse(kind.stdout).error.code, "KIND_NOT_SUPPORTED");

        const badName = JSON.parse(sfBuild(["package", "--json", "--name", "Acme", "--package-root", ".", "--ui-source", ".", "--out", "o"], { cwd: empty, env }).stdout);
        assert.match(badName.error.message, /package name must match/u);

        const noReport = sfBuild(["receipt", "--json"], { cwd: empty, env });
        assert.equal(noReport.status, 2);
        assert.match(JSON.parse(noReport.stdout).error.message, /--report/u);

        const frameworkNoOut = JSON.parse(sfBuild(["framework", "--json", "--ui-source", "."], { cwd: empty, env }).stdout);
        assert.match(frameworkNoOut.error.message, /give --out .* or --workspace/u);

        const existingWorkspace = JSON.parse(sfBuild(["verify", "framework", "--json", "--ui-source", ".", "--workspace", "."], { cwd: empty, env }).stdout);
        assert.equal(existingWorkspace.error.code, "WORKSPACE_CONFLICT");
    }
    finally
    {
        fs.rmSync(empty, { force: true, recursive: true });
    }
});
