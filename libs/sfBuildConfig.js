"use strict";

// sf-build configuration (schemas/sf-build.config.v1.schema.json). The file is
// validated against the schema itself, through a small validator for the
// subset of JSON Schema the schema uses, so the two cannot drift and the
// builder takes no new dependency.

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_SCHEMA_ID = "simai.sf-build.config.v1";
const CONFIG_FILE_NAME = "sf-build.config.json";
const SCHEMA_PATH = path.resolve(__dirname, "../schemas/sf-build.config.v1.schema.json");
// Kinds the owner decision of 2026-10-11 names. `components` and `theme` are
// built; the others are recognised so that the error says "not yet", not
// "unknown".
const SUPPORTED_KINDS = Object.freeze(["components", "theme"]);
const RESERVED_KINDS = Object.freeze(["utility", "composition-type"]);

class SfBuildError extends Error
{
    constructor(code, message, details)
    {
        super(message);
        this.name = "SfBuildError";
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

function typeOf(value)
{
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (Number.isInteger(value)) return "integer";
    return typeof value;
}

/** Problems of `value` against `schema`, as "<path>: <what>" strings. */
function validateAgainst(schema, value, at = "$")
{
    const problems = [];

    if (schema.const !== undefined && value !== schema.const)
    {
        problems.push(`${at}: must be ${JSON.stringify(schema.const)}`);
        return problems;
    }

    if (schema.type !== undefined)
    {
        const actual = typeOf(value);
        const allowed = [].concat(schema.type);

        if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number")))
        {
            problems.push(`${at}: must be ${allowed.join(" or ")}, not ${actual}`);
            return problems;
        }
    }

    if (schema.enum !== undefined && !schema.enum.includes(value))
    {
        problems.push(`${at}: must be one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`);
    }

    if (typeof value === "string")
    {
        if (schema.minLength !== undefined && value.length < schema.minLength)
        {
            problems.push(`${at}: must not be empty`);
        }

        if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
        {
            problems.push(`${at}: must match ${schema.pattern}`);
        }
    }

    if (typeOf(value) === "object")
    {
        const properties = schema.properties || {};

        for (const key of schema.required || [])
        {
            if (!Object.prototype.hasOwnProperty.call(value, key))
            {
                problems.push(`${at}: ${key} is required`);
            }
        }

        for (const [key, item] of Object.entries(value))
        {
            if (Object.prototype.hasOwnProperty.call(properties, key))
            {
                problems.push(...validateAgainst(properties[key], item, `${at}.${key}`));
            }
            else if (schema.additionalProperties === false)
            {
                problems.push(`${at}: unknown property ${key}`);
            }
        }
    }

    return problems;
}

function configSchema()
{
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

/** Throws CONFIG_INVALID (or KIND_NOT_SUPPORTED) unless `config` is a valid v1 configuration. */
function validateConfig(config, label = "configuration")
{
    const kind = config && config.package && config.package.kind;

    if (RESERVED_KINDS.includes(kind))
    {
        throw new SfBuildError(
            "KIND_NOT_SUPPORTED",
            `${label}: package kind ${kind} is not built yet; this version builds ${SUPPORTED_KINDS.join(", ")}`,
            { kind, supported: SUPPORTED_KINDS },
        );
    }

    const problems = validateAgainst(configSchema(), config);

    if (problems.length !== 0)
    {
        throw new SfBuildError("CONFIG_INVALID", `${label} is not a valid ${CONFIG_SCHEMA_ID}:\n  ${problems.join("\n  ")}`, { problems });
    }

    return config;
}

/**
 * Read and validate a configuration file. Relative paths in it are resolved
 * against the directory that holds the file. Returns
 * `{file, directory, config, resolved}` where `resolved` holds absolute paths.
 */
function loadConfig(file)
{
    const absolute = path.resolve(file);
    let source;

    try
    {
        source = fs.readFileSync(absolute, "utf8");
    }
    catch (error)
    {
        throw new SfBuildError("CONFIG_INVALID", `cannot read ${absolute}: ${error.code || error.message}`);
    }

    let config;

    try
    {
        config = JSON.parse(source);
    }
    catch (error)
    {
        throw new SfBuildError("CONFIG_INVALID", `${absolute} is not JSON: ${error.message}`);
    }

    validateConfig(config, absolute);
    const directory = path.dirname(absolute);
    const at = value => value === undefined ? undefined : path.resolve(directory, value);
    const framework = config.framework || {};

    return {
        config,
        directory,
        file: absolute,
        resolved: {
            kind: config.package.kind,
            name: config.package.name,
            out: at(config.out),
            packageRepository: config.package.repository,
            packageRevision: config.package.revision,
            packageRoot: at(config.package.path || "."),
            ui: at(framework.ui),
            uiSource: at(framework.source),
            workspace: at(config.workspace),
        },
    };
}

module.exports = {
    CONFIG_FILE_NAME,
    CONFIG_SCHEMA_ID,
    RESERVED_KINDS,
    SCHEMA_PATH,
    SUPPORTED_KINDS,
    SfBuildError,
    configSchema,
    loadConfig,
    validateAgainst,
    validateConfig,
};
