#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildIconSubset } = require("../libs/iconSubset");
const { collectIconRequirements } = require("../libs/iconRequirements");

function parseArgs(argv)
{
    const values = {};
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (!argument.startsWith("--"))
        {
            continue;
        }
        const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
        const value = inlineValue ?? argv[index + 1];
        if (inlineValue == null)
        {
            index += 1;
        }
        values[rawKey] = value;
    }
    return values;
}

function list(value)
{
    return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function assertRegularFile(filePath, label)
{
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    {
        throw new Error(`${label} must be one regular, non-linked file`);
    }
}

function writeExact(filePath, content)
{
    if (fs.existsSync(filePath))
    {
        assertRegularFile(filePath, "Existing output");
        const existing = fs.readFileSync(filePath);
        const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
        if (!existing.equals(next))
        {
            throw new Error(`Refusing to overwrite changed output: ${filePath}`);
        }
        return;
    }
    fs.writeFileSync(filePath, content, { flag: "wx" });
}

async function main()
{
    const [command, ...rawArgs] = process.argv.slice(2);
    if (command !== "build")
    {
        throw new Error("Usage: sf-icons build --font FILE --icons a,b --out DIR [options]");
    }

    const args = parseArgs(rawArgs);
    if (!args.font || (!args.icons && !args.html) || !args.out)
    {
        throw new Error("--font, --out and either --icons or --html are required");
    }

    const fontPath = path.resolve(args.font);
    const outputRoot = path.resolve(args.out);
    assertRegularFile(fontPath, "Source font");
    if (fs.existsSync(outputRoot) && fs.lstatSync(outputRoot).isSymbolicLink())
    {
        throw new Error("Output root must not be a symbolic link");
    }
    fs.mkdirSync(outputRoot, { recursive: true });

    const family = args.family || "outlined";
    const manifests = list(args.manifests).map(manifestPath => {
        const exactPath = path.resolve(manifestPath);
        assertRegularFile(exactPath, "Component manifest");
        return JSON.parse(fs.readFileSync(exactPath, "utf8"));
    });
    const discovered = args.html
        ? (() => {
            const htmlPath = path.resolve(args.html);
            assertRegularFile(htmlPath, "HTML input");
            return collectIconRequirements({
            html: fs.readFileSync(htmlPath, "utf8"),
            manifests,
            }).find(requirement => requirement.family === family);
        })()
        : null;
    const result = await buildIconSubset({
        axes: {
            fill: list(args.fill || discovered?.axes.FILL || "0"),
            grade: list(args.grade || discovered?.axes.GRAD || "0"),
            opticalSize: list(args["optical-size"] || discovered?.axes.opsz || "24"),
            weight: list(args.weight || discovered?.axes.wght || "400"),
        },
        family,
        generatorRevision: args["generator-revision"] || null,
        icons: args.icons ? list(args.icons) : discovered?.icons || [],
        license: args.license || "Apache-2.0",
        provenance: args.provenance || null,
        publicBase: args["public-base"] || "./",
        source: fs.readFileSync(fontPath),
        sourceRevision: args["source-revision"] || null,
        sourceSha256: args["source-sha256"] || null,
    });

    writeExact(path.join(outputRoot, result.files.font), result.font);
    writeExact(path.join(outputRoot, result.files.css), result.css);
    writeExact(path.join(outputRoot, result.files.manifest), result.manifestJson);

    process.stdout.write(`${JSON.stringify({
        drawn_icons: result.drawnIcons,
        files: result.files,
        manifest: result.manifest,
        output_root: outputRoot,
        status: "success",
    }, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
});
