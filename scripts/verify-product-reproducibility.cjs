#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BUILDER_ROOT = path.resolve(__dirname, "..");
const PRODUCTS = Object.freeze(["core", "component", "utility", "smart"]);

function fail(message)
{
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
}

function isWithin(root, candidate)
{
    const relative = path.relative(root, candidate);

    return relative === ""
        || (!relative.startsWith(`..${path.sep}`)
            && relative !== ".."
            && !path.isAbsolute(relative));
}

function sha256(value)
{
    return crypto.createHash("sha256").update(value).digest("hex");
}

function filesUnder(root, current = root)
{
    return fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : 1)
        .flatMap(entry => {
            const absolute = path.join(current, entry.name);

            if (entry.isSymbolicLink())
            {
                throw new Error(`output symlink is forbidden: ${absolute}`);
            }

            if (entry.isDirectory())
            {
                return filesUnder(root, absolute);
            }

            if (!entry.isFile())
            {
                throw new Error(`unsupported output entry: ${absolute}`);
            }

            const contents = fs.readFileSync(absolute);

            return [{
                path: path.relative(root, absolute).split(path.sep).join("/"),
                sha256: sha256(contents),
                size: contents.length,
            }];
        });
}

function manifestFor(root)
{
    const files = filesUnder(root);

    return {
        files,
        files_count: files.length,
        manifest_sha256: sha256(`${JSON.stringify(files)}\n`),
    };
}

function runNode(argumentsList, options)
{
    const result = spawnSync(process.execPath, argumentsList, {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env || process.env,
        maxBuffer: 128 * 1024 * 1024,
    });

    fs.writeFileSync(options.stdoutPath, result.stdout || "");
    fs.writeFileSync(options.stderrPath, result.stderr || "");

    if (result.error || result.status !== 0)
    {
        throw new Error(
            `${options.label} failed with status ${String(result.status)}; `
            + `see ${options.stderrPath}`,
        );
    }
}

function buildProduct(product, context)
{
    const outputRoot = path.join(context.waveRoot, "output", product);
    const diagnosticsPath = path.join(
        context.waveRoot,
        "diagnostics",
        `${product}.json`,
    );
    const common = [
        BUILDER_ROOT,
        context.sourceRoot,
        outputRoot,
        diagnosticsPath,
    ];
    let script;
    let argumentsList;

    if (product === "core")
    {
        script = path.join(__dirname, "run-core-product-build.cjs");
        argumentsList = [script, ...common];
    }
    else if (product === "smart")
    {
        script = path.join(__dirname, "run-smart-product-build.cjs");
        argumentsList = [script, ...common];
    }
    else
    {
        script = path.join(
            __dirname,
            "run-component-utility-product-build.cjs",
        );
        argumentsList = [script, product, ...common];
    }

    runNode(argumentsList, {
        cwd: BUILDER_ROOT,
        env: context.env,
        label: `${context.waveName}/${product}`,
        stderrPath: `${diagnosticsPath}.stderr.log`,
        stdoutPath: `${diagnosticsPath}.stdout.log`,
    });

    const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));

    if (diagnostics.status !== 0 || diagnostics.diagnostics.length !== 0)
    {
        throw new Error(`${context.waveName}/${product} has diagnostics`);
    }

    return {
        diagnostics_count: diagnostics.diagnostics.length,
        ...manifestFor(outputRoot),
    };
}

function prepareRuntime(packageRoot, runtimeRoot, diagnosticsPath, label)
{
    runNode([
        path.join(__dirname, "prepare-frozen-dependency-runtime.cjs"),
        packageRoot,
        runtimeRoot,
        diagnosticsPath,
    ], {
        cwd: BUILDER_ROOT,
        label,
        stderrPath: `${diagnosticsPath}.stderr.log`,
        stdoutPath: `${diagnosticsPath}.stdout.log`,
    });
}

function runWave(waveName, workspaceRoot, uiLoaderRoot)
{
    const waveRoot = path.join(workspaceRoot, waveName);
    const builderRuntime = path.join(waveRoot, "builder-runtime");
    const sourceRuntime = path.join(waveRoot, "source-runtime");
    const diagnosticsRoot = path.join(waveRoot, "diagnostics");

    fs.mkdirSync(diagnosticsRoot, { recursive: true });
    prepareRuntime(
        BUILDER_ROOT,
        builderRuntime,
        path.join(diagnosticsRoot, "builder-runtime.json"),
        `${waveName}/builder-runtime`,
    );
    prepareRuntime(
        uiLoaderRoot,
        sourceRuntime,
        path.join(diagnosticsRoot, "source-runtime.json"),
        `${waveName}/source-runtime`,
    );

    const context = {
        env: {
            ...process.env,
            SF_BUILDER_DEPENDENCY_ROOT: builderRuntime,
            SF_SOURCE_DEPENDENCY_ROOT: sourceRuntime,
        },
        sourceRoot: path.join(uiLoaderRoot, "src"),
        waveName,
        waveRoot,
    };

    return Object.fromEntries(PRODUCTS.map(product => [
        product,
        buildProduct(product, context),
    ]));
}

function main()
{
    const [uiLoaderInput, workspaceInput] = process.argv.slice(2);

    if (!uiLoaderInput || !workspaceInput
        || !path.isAbsolute(uiLoaderInput)
        || !path.isAbsolute(workspaceInput))
    {
        fail("usage: verify-product-reproducibility.cjs <absolute-ui-loader-root> <new-absolute-workspace-root>");
        return;
    }

    const uiLoaderRoot = path.resolve(uiLoaderInput);
    const workspaceRoot = path.resolve(workspaceInput);

    if (!fs.existsSync(path.join(uiLoaderRoot, "package.json"))
        || !fs.existsSync(path.join(uiLoaderRoot, "yarn.lock"))
        || !fs.existsSync(path.join(uiLoaderRoot, "src")))
    {
        fail("ui-loader root must contain package.json, yarn.lock and src");
        return;
    }

    if (fs.existsSync(workspaceRoot))
    {
        fail("workspace root must not exist");
        return;
    }

    if (isWithin(BUILDER_ROOT, workspaceRoot)
        || isWithin(uiLoaderRoot, workspaceRoot))
    {
        fail("workspace root must be outside builder and ui-loader roots");
        return;
    }

    fs.mkdirSync(workspaceRoot, { recursive: true });

    const report = {
        builder_root: BUILDER_ROOT,
        node: process.version,
        products: {},
        schema_version: 1,
        status: "PASS",
        ui_loader_root: uiLoaderRoot,
        waves: {},
    };

    try
    {
        report.waves.wave_1 = runWave("wave-1", workspaceRoot, uiLoaderRoot);
        report.waves.wave_2 = runWave("wave-2", workspaceRoot, uiLoaderRoot);

        for (const product of PRODUCTS)
        {
            const first = report.waves.wave_1[product];
            const second = report.waves.wave_2[product];
            const byteIdentical = first.manifest_sha256
                === second.manifest_sha256
                && JSON.stringify(first.files) === JSON.stringify(second.files);

            report.products[product] = {
                byte_identical: byteIdentical,
                files_count: first.files_count,
                manifest_sha256: first.manifest_sha256,
            };

            if (!byteIdentical)
            {
                throw new Error(`${product} waves are not byte-identical`);
            }
        }
    }
    catch (error)
    {
        report.error = error && error.stack ? error.stack : String(error);
        report.status = "FAIL";
        process.exitCode = 1;
    }

    const reportPath = path.join(workspaceRoot, "report.json");

    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
        products: report.products,
        report: reportPath,
        status: report.status,
    }, null, 2)}\n`);
}

main();
