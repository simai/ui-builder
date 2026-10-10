#!/usr/bin/env node
"use strict";

// Build SIMAI Framework Pro twice and require the two waves to be
// byte-identical, as verify-product-reproducibility.cjs does for the free
// products.
//
// usage: verify-pro-reproducibility.cjs <ui-source-pro root> <ui-source root>
//            <new workspace root> [--pro-revision <commit, default HEAD>]
//
// Each wave lays its own overlay (ui-source at the revision ui-source-pro pins
// in framework.lock.json, with ui-source-pro at --pro-revision over it; both
// from git, never from a working tree), prepares frozen dependency runtimes for
// the builder and for the overlay (ui-source's package.json and yarn.lock),
// and runs scripts/run-pro-product-build.cjs. wave-1/output/pro holds smart/
// for a release (scripts/publish-pro-release.sh); wave-1/overlay is the tree
// the Pro tests run in.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { materializeProOverlay, PRO_COMPONENTS, RULE_FILE } = require("../libs/proProduct");

const BUILDER_ROOT = path.resolve(__dirname, "..");

function sha256(value)
{
    return crypto.createHash("sha256").update(value).digest("hex");
}

function isWithin(root, candidate)
{
    const relative = path.relative(root, candidate);

    return relative === ""
        || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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

            const contents = fs.readFileSync(absolute);

            return [{
                path: path.relative(root, absolute).split(path.sep).join("/"),
                sha256: sha256(contents),
                size: contents.length,
            }];
        });
}

function runNode(argumentsList, options)
{
    const result = spawnSync(process.execPath, argumentsList, {
        cwd: BUILDER_ROOT,
        encoding: "utf8",
        env: options.env || process.env,
        maxBuffer: 128 * 1024 * 1024,
    });

    fs.writeFileSync(`${options.log}.stdout.log`, result.stdout || "");
    fs.writeFileSync(`${options.log}.stderr.log`, result.stderr || "");

    if (result.error || result.status !== 0)
    {
        throw new Error(`${options.label} failed with status ${String(result.status)}; see ${options.log}.stderr.log`);
    }
}

function runWave(waveName, context)
{
    const waveRoot = path.join(context.workspaceRoot, waveName);
    const overlayRoot = path.join(waveRoot, "overlay");
    const diagnosticsRoot = path.join(waveRoot, "diagnostics");
    const outputRoot = path.join(waveRoot, "output", "pro");
    const diagnosticsPath = path.join(diagnosticsRoot, "pro.json");

    fs.mkdirSync(diagnosticsRoot, { recursive: true });
    const overlay = materializeProOverlay({
        overlayRoot,
        proRevision: context.proRevision,
        proRoot: context.proRoot,
        uiSourceRoot: context.uiSourceRoot,
    });

    for (const [label, packageRoot] of [["builder-runtime", BUILDER_ROOT], ["source-runtime", overlayRoot]])
    {
        const log = path.join(diagnosticsRoot, `${label}.json`);
        runNode([path.join(__dirname, "prepare-frozen-dependency-runtime.cjs"), packageRoot, path.join(waveRoot, label), log], {
            label: `${waveName}/${label}`,
            log,
        });
    }

    runNode([path.join(__dirname, "run-pro-product-build.cjs"), BUILDER_ROOT, path.join(overlayRoot, "src"), outputRoot, diagnosticsPath], {
        env: {
            ...process.env,
            SF_BUILDER_DEPENDENCY_ROOT: path.join(waveRoot, "builder-runtime"),
            SF_SOURCE_DEPENDENCY_ROOT: path.join(waveRoot, "source-runtime"),
        },
        label: `${waveName}/pro`,
        log: diagnosticsPath,
    });

    const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));

    if (diagnostics.status !== 0 || diagnostics.diagnostics.length !== 0)
    {
        throw new Error(`${waveName}/pro has diagnostics`);
    }

    // The product is the four Pro folders and the rule file, nothing else.
    const top = fs.readdirSync(path.join(outputRoot, "smart")).sort();
    const expected = [...PRO_COMPONENTS, path.basename(RULE_FILE), `${path.basename(RULE_FILE)}.gz`].sort();

    if (JSON.stringify(top) !== JSON.stringify(expected) || fs.readdirSync(outputRoot).join() !== "smart")
    {
        throw new Error(`${waveName}/pro holds ${top.join(", ")}; expected ${expected.join(", ")}`);
    }

    const files = filesUnder(outputRoot);

    return {
        ...overlay,
        files,
        files_count: files.length,
        manifest_sha256: sha256(`${JSON.stringify(files)}\n`),
    };
}

function main()
{
    const argv = process.argv.slice(2);
    const at = argv.indexOf("--pro-revision");
    const proRevision = at === -1 ? "HEAD" : argv[at + 1];
    const positional = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
    const [proInput, uiSourceInput, workspaceInput, ...unexpected] = positional;

    if (!proInput || !uiSourceInput || !workspaceInput || unexpected.length || !proRevision
        || ![proInput, uiSourceInput, workspaceInput].every(value => path.isAbsolute(value)))
    {
        process.stderr.write("usage: verify-pro-reproducibility.cjs <absolute-ui-source-pro-root> <absolute-ui-source-root> <new-absolute-workspace-root> [--pro-revision <commit>]\n");
        process.exitCode = 2;
        return;
    }

    const context = {
        proRevision,
        proRoot: path.resolve(proInput),
        uiSourceRoot: path.resolve(uiSourceInput),
        workspaceRoot: path.resolve(workspaceInput),
    };

    if (fs.existsSync(context.workspaceRoot))
    {
        process.stderr.write("workspace root must not exist\n");
        process.exitCode = 2;
        return;
    }

    if ([BUILDER_ROOT, context.proRoot, context.uiSourceRoot].some(root => isWithin(root, context.workspaceRoot)))
    {
        process.stderr.write("workspace root must be outside builder, ui-source-pro and ui-source roots\n");
        process.exitCode = 2;
        return;
    }

    fs.mkdirSync(context.workspaceRoot, { recursive: true });
    const report = {
        builder_root: BUILDER_ROOT,
        node: process.version,
        product: "pro",
        schema_version: 1,
        status: "PASS",
        ui_source_pro_root: context.proRoot,
        ui_source_root: context.uiSourceRoot,
        waves: {},
    };

    try
    {
        report.waves.wave_1 = runWave("wave-1", context);
        report.waves.wave_2 = runWave("wave-2", context);
        const [first, second] = [report.waves.wave_1, report.waves.wave_2];
        report.pro_revision = first.pro_revision;
        report.source_revision = first.source_revision;
        report.products = {
            pro: {
                byte_identical: first.manifest_sha256 === second.manifest_sha256
                    && JSON.stringify(first.files) === JSON.stringify(second.files),
                files_count: first.files_count,
                manifest_sha256: first.manifest_sha256,
            },
        };

        if (!report.products.pro.byte_identical)
        {
            throw new Error("pro waves are not byte-identical");
        }
    }
    catch (error)
    {
        report.error = error && error.stack ? error.stack : String(error);
        report.status = "FAIL";
        process.exitCode = 1;
    }

    const reportPath = path.join(context.workspaceRoot, "report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
        products: report.products,
        pro_revision: report.pro_revision,
        report: reportPath,
        source_revision: report.source_revision,
        status: report.status,
    }, null, 2)}\n`);
}

main();
