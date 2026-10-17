#!/usr/bin/env node
"use strict";

// sf-build: build SIMAI Framework and its extension packages
// (docs/developer/architecture-sf-build.md). A thin command line over
// libs/api.js; every command can print the API's JSON result with --json.

const fs = require("node:fs");
const path = require("node:path");

const api = require("../libs/api");

const USAGE = `sf-build: build SIMAI Framework and its extension packages

Usage:
  sf-build package   [options]            build a package twice, write its receipt, lay it into --out
  sf-build framework [options]            build the Framework twice, lay wave 1 into --out
  sf-build verify package|framework [options]
                                          build twice and compare; nothing is laid
  sf-build receipt --report <report.json> [--ui <dir>] [--out <dir>]
                                          write the receipt of a verified package build
  sf-build help | --help | --version

Package options:
  --config <file>              sf-build.config.json (default: ./sf-build.config.json when present)
  --name <name>                package name, the key of SF_BOOT_CONFIG.packages
  --kind <kind>                package kind: components (default) or theme; utility and
                               composition-type are reserved for later versions
                               (a theme package lays <out>/theme/theme.css, theme.json
                               and theme-receipt.json)
  --package-root <dir>         the package folder: framework.lock.json and src/smart/<folder>/
  --package-revision <commit>  the commit to build (default: HEAD; never the working tree)
  --package-repository <id>    repository id for the receipt (default: the origin remote)
  --ui-source <dir>            ui-source checkout holding the pinned revision (env SF_BUILD_UI_SOURCE)
  --ui <dir>                   ui checkout: name the free release in the receipt and check
                               the package against it (env SF_BUILD_UI)

Framework options:
  --ui-source <dir>            ui-source checkout to build (its working tree, as the release route does)
  --require-legacy-compatibility
                               require the SF_LEGACY_COMPATIBILITY_* binding

Output options:
  --out <dir>                  the output path; package: <out>/smart, package-receipt.json,
                               package-<name>.tar; framework: <out>/{core,component,utility,smart},
                               build-report.json
  --replace-out                replace an existing --out that sf-build laid earlier
  --workspace <dir>            a new directory for the two waves (default: a temporary one,
                               removed after a successful run that lays --out)
  --keep-workspace             keep the temporary workspace
  --json                       print the result as JSON (schema simai.sf-build.result.v1) on stdout

Exit codes:
  0 built and verified     1 build failed or waves differ     2 usage, configuration or --out conflict
  3 receipt refused (the package disagrees with the free release)
  4 environment (Node.js < 20.19.0, git or python3 missing, builder not a git checkout)
`;

const VALUE_OPTIONS = Object.freeze({
    "--config": "config",
    "--kind": "kind",
    "--name": "name",
    "--out": "out",
    "--package-repository": "packageRepository",
    "--package-revision": "packageRevision",
    "--package-root": "packageRoot",
    "--report": "report",
    "--ui": "ui",
    "--ui-source": "uiSource",
    "--workspace": "workspace",
});
const FLAG_OPTIONS = Object.freeze({
    "--json": "json",
    "--keep-workspace": "keepWorkspace",
    "--replace-out": "replaceOut",
    "--require-legacy-compatibility": "requireLegacyCompatibility",
});
const PACKAGE_OPTIONS = ["config", "kind", "name", "packageRepository", "packageRevision", "packageRoot", "ui", "uiSource"];
const OUTPUT_OPTIONS = ["out", "replaceOut", "workspace", "keepWorkspace"];
const ALLOWED = Object.freeze({
    framework: ["config", "uiSource", "requireLegacyCompatibility", ...OUTPUT_OPTIONS],
    package: [...PACKAGE_OPTIONS, ...OUTPUT_OPTIONS],
    receipt: ["report", "ui", "out", "replaceOut"],
    "verify framework": ["config", "uiSource", "requireLegacyCompatibility", "workspace", "keepWorkspace"],
    "verify package": [...PACKAGE_OPTIONS, "workspace", "keepWorkspace"],
});
const FLAG_NAMES = Object.fromEntries(Object.entries({ ...VALUE_OPTIONS, ...FLAG_OPTIONS }).map(([flag, key]) => [key, flag]));

/**
 * `{command, target, options, json}` for an argument list, or
 * `{command: "help" | "version"}`. Throws SfBuildError USAGE.
 */
function parseArguments(argv)
{
    const positional = [];
    const options = {};
    let json = false;

    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];

        if (argument === "--help" || argument === "-h")
        {
            return { command: "help" };
        }

        if (argument === "--version")
        {
            return { command: "version" };
        }

        if (!argument.startsWith("--"))
        {
            positional.push(argument);
            continue;
        }

        const equals = argument.indexOf("=");
        const flag = equals === -1 ? argument : argument.slice(0, equals);

        if (Object.prototype.hasOwnProperty.call(FLAG_OPTIONS, flag))
        {
            if (equals !== -1)
            {
                throw new api.SfBuildError("USAGE", `${flag} takes no value`);
            }

            if (flag === "--json") json = true;
            else options[FLAG_OPTIONS[flag]] = true;
            continue;
        }

        if (!Object.prototype.hasOwnProperty.call(VALUE_OPTIONS, flag))
        {
            throw new api.SfBuildError("USAGE", `unknown option ${flag}`);
        }

        const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);

        if (equals === -1) index += 1;

        if (value === undefined || value === "" || (equals === -1 && value.startsWith("--")))
        {
            throw new api.SfBuildError("USAGE", `${flag} needs a value`);
        }

        const key = VALUE_OPTIONS[flag];

        if (Object.prototype.hasOwnProperty.call(options, key))
        {
            throw new api.SfBuildError("USAGE", `${flag} is given twice`);
        }

        options[key] = value;
    }

    const [command, ...rest] = positional;

    if (command === undefined || command === "help")
    {
        return { command: "help" };
    }

    let target;
    let scope = command;

    if (command === "verify")
    {
        target = rest.shift();

        if (target !== "package" && target !== "framework")
        {
            throw new api.SfBuildError("USAGE", "verify needs a target: sf-build verify package|framework");
        }

        scope = `verify ${target}`;
    }
    else if (!["framework", "package", "receipt"].includes(command))
    {
        throw new api.SfBuildError("USAGE", `unknown command ${command}`);
    }

    if (rest.length !== 0)
    {
        throw new api.SfBuildError("USAGE", `unexpected argument ${rest[0]}`);
    }

    const foreign = Object.keys(options).filter(key => !ALLOWED[scope].includes(key));

    if (foreign.length !== 0)
    {
        throw new api.SfBuildError("USAGE", `${scope} does not take ${foreign.map(key => FLAG_NAMES[key]).join(", ")}`);
    }

    return { command, json, options, target };
}

function dispatch(parsed, extra)
{
    const options = { ...parsed.options, ...extra };

    if (parsed.command === "package") return api.buildPackage(options);
    if (parsed.command === "framework") return api.buildFramework(options);
    if (parsed.command === "receipt") return api.writeReceipt(options);

    return parsed.target === "package" ? api.verifyPackage(options) : api.verifyFramework(options);
}

function human(result)
{
    const lines = [`sf-build ${result.command}${result.target ? ` ${result.target}` : ""}: ${result.status}`];

    if (result.error)
    {
        lines.push(`${result.error.code}: ${result.error.message}`);
    }

    if (result.package) lines.push(`package      ${result.package} (${result.kind})`);
    if (result.source_revision) lines.push(`ui-source    ${result.source_revision}`);
    if (result.framework) lines.push(`release      ${result.framework.release || "none resolved (no --ui, or not released yet)"}`);
    if (result.output && result.output.manifest_sha256) lines.push(`manifest     ${result.output.manifest_sha256}`);
    if (result.output && result.output.archive_sha256) lines.push(`archive      ${result.output.archive_sha256}`);
    if (result.products)
    {
        for (const [product, value] of Object.entries(result.products))
        {
            lines.push(`${product.padEnd(12)} ${value.files_count} files, ${value.manifest_sha256}`);
        }
    }
    if (result.out) lines.push(`out          ${result.out.root}`);
    if (result.receipt) lines.push(`receipt      ${result.receipt}`);
    if (result.workspace && result.workspace.kept) lines.push(`workspace    ${result.workspace.root}`);
    for (const warning of result.warnings || []) lines.push(`warning      ${warning}`);

    return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2), io = { stderr: process.stderr, stdout: process.stdout })
{
    let parsed;

    try
    {
        parsed = parseArguments(argv);
    }
    catch (error)
    {
        const result = {
            schema: api.RESULT_SCHEMA,
            command: argv.find(item => !item.startsWith("--")) || null,
            status: "FAIL",
            exit_code: api.EXIT_CODES.USAGE,
            error: { code: error.code || "USAGE", message: error.message },
        };

        if (argv.includes("--json"))
        {
            io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        else
        {
            io.stderr.write(`sf-build: ${error.message}\nRun sf-build --help for usage.\n`);
        }

        return result.exit_code;
    }

    if (parsed.command === "help")
    {
        io.stdout.write(USAGE);
        return 0;
    }

    if (parsed.command === "version")
    {
        const manifest = JSON.parse(fs.readFileSync(path.join(api.BUILDER_ROOT, "package.json"), "utf8"));
        io.stdout.write(`${manifest.name} ${manifest.version}\n`);
        return 0;
    }

    const result = await dispatch(parsed, {
        onProgress: parsed.json ? undefined : message => io.stderr.write(`sf-build: ${message}\n`),
    });

    if (parsed.json)
    {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    else
    {
        (result.status === "PASS" ? io.stdout : io.stderr).write(human(result));
    }

    return result.exit_code;
}

if (require.main === module)
{
    main().then(code => {
        process.exitCode = code;
    });
}

module.exports = { USAGE, main, parseArguments };
