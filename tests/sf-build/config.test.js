"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    CONFIG_SCHEMA_ID,
    configSchema,
    loadConfig,
    validateConfig,
} = require("../../libs/sfBuildConfig");

const VALID = Object.freeze({
    schema: CONFIG_SCHEMA_ID,
    package: { name: "larena", kind: "components", path: "resources/ui", repository: "simai/larena", revision: "HEAD" },
    framework: { source: "../ui-source", ui: "../ui" },
    out: "public/vendor/larena-ui",
});

function problemsOf(config)
{
    try
    {
        validateConfig(config);
        return null;
    }
    catch (error)
    {
        return error;
    }
}

test("the schema file is the one the validator reads, and a full configuration is valid", () => {
    const schema = configSchema();
    assert.equal(schema.properties.schema.const, CONFIG_SCHEMA_ID);
    assert.deepEqual(schema.properties.package.properties.kind.enum, ["components", "theme"]);
    assert.equal(validateConfig(VALID), VALID);
    assert.equal(validateConfig({ schema: CONFIG_SCHEMA_ID, package: { name: "acme", kind: "components" } }).package.name, "acme");
    assert.equal(problemsOf({ ...VALID, $schema: "./node_modules/@simai/ui-builder/schemas/sf-build.config.v1.schema.json" }), null);
});

test("an invalid configuration names every problem with its path", () => {
    const error = problemsOf({
        schema: "simai.sf-build.config.v2",
        package: { name: "Larena", kind: "components", extra: 1, path: "" },
        framework: { source: 7 },
        output: "dist",
    });
    assert.equal(error.code, "CONFIG_INVALID");
    assert.deepEqual(error.details.problems, [
        "$.schema: must be \"simai.sf-build.config.v1\"",
        "$.package.name: must match ^[a-z][a-z0-9-]*$",
        "$.package: unknown property extra",
        "$.package.path: must not be empty",
        "$.framework.source: must be string, not integer",
        "$: unknown property output",
    ]);
    assert.deepEqual(problemsOf({ schema: CONFIG_SCHEMA_ID }).details.problems, ["$: package is required"]);
    assert.deepEqual(problemsOf({ schema: CONFIG_SCHEMA_ID, package: { name: "a" } }).details.problems, ["$.package: kind is required"]);
    assert.deepEqual(problemsOf([]).details.problems, ["$: must be object, not array"]);
});

test("the kinds the owner decision reserves are refused as not supported yet, an unknown kind as invalid", () => {
    for (const kind of ["utility", "composition-type"])
    {
        const error = problemsOf({ ...VALID, package: { ...VALID.package, kind } });
        assert.equal(error.code, "KIND_NOT_SUPPORTED", kind);
        assert.match(error.message, /is not built yet/u);
    }

    const unknown = problemsOf({ ...VALID, package: { ...VALID.package, kind: "plugin" } });
    assert.equal(unknown.code, "CONFIG_INVALID");
    assert.match(unknown.message, /\$\.package\.kind: must be one of "components", "theme"/u);
});

test("a configuration file resolves its paths against its own directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-build-config-"));

    try
    {
        const file = path.join(root, "product", "sf-build.config.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(VALID));
        const loaded = loadConfig(file);
        assert.equal(loaded.file, file);
        assert.deepEqual(loaded.resolved, {
            kind: "components",
            name: "larena",
            out: path.join(root, "product/public/vendor/larena-ui"),
            packageRepository: "simai/larena",
            packageRevision: "HEAD",
            packageRoot: path.join(root, "product/resources/ui"),
            ui: path.join(root, "ui"),
            uiSource: path.join(root, "ui-source"),
            workspace: undefined,
        });

        fs.writeFileSync(file, JSON.stringify({ schema: CONFIG_SCHEMA_ID, package: { name: "acme", kind: "components" } }));
        assert.equal(loadConfig(file).resolved.packageRoot, path.join(root, "product"), "the package folder defaults to the file's directory");

        fs.writeFileSync(file, "{ not json");
        assert.throws(() => loadConfig(file), error => error.code === "CONFIG_INVALID" && /is not JSON/u.test(error.message));
        assert.throws(() => loadConfig(path.join(root, "missing.json")), error => error.code === "CONFIG_INVALID" && /cannot read/u.test(error.message));
    }
    finally
    {
        fs.rmSync(root, { force: true, recursive: true });
    }
});
