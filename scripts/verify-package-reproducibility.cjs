#!/usr/bin/env node
"use strict";

// Build a product component package twice and require the two waves to be
// byte-identical (docs/developer/product-packages.md).
//
// usage: verify-package-reproducibility.cjs <package-source-root> <ui-source root>
//            <new workspace root> --package <name>
//            [--package-revision <commit, default HEAD>]
//        verify-package-reproducibility.cjs <ui-source root> <new workspace root>
//            --package <name> --package-source <repository> [--package-path <subdir>]
//            [--package-revision <commit>] [--package-repository <id>]
//
// The package source is a folder that holds framework.lock.json and
// src/smart/<folder>/ (plus tests/ and docs/), either given as a path inside a
// git checkout, or as a repository and a subdirectory of it. Each wave lays its
// own overlay (ui-source at the revision the package pins, with the package at
// --package-revision over it; both from git, never from a working tree),
// prepares frozen dependency runtimes for the builder and for the overlay
// (ui-source's package.json and yarn.lock), and runs
// scripts/run-package-product-build.cjs. wave-1/output/package/<name> holds
// smart/ (the package's folders and rule.js); wave-1/overlay is the tree the
// package's tests run in. scripts/write-package-receipt.py turns report.json
// into the package receipt a consumer pins.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
    RULE_FILE,
    assertPackageName,
    git,
    materializePackageOverlay,
    resolvePackageSource,
} = require("../libs/packageProduct");

const BUILDER_ROOT = path.resolve(__dirname, "..");
const USAGE = [
    "usage: verify-package-reproducibility.cjs <package-source-root> <ui-source-root> <new-workspace-root> --package <name> [--package-revision <commit>]",
    "       verify-package-reproducibility.cjs <ui-source-root> <new-workspace-root> --package <name> --package-source <repository> [--package-path <subdir>] [--package-revision <commit>] [--package-repository <id>]",
    "",
].join("\n");
const OPTIONS = Object.freeze([
    "--package",
    "--package-path",
    "--package-repository",
    "--package-revision",
    "--package-source",
]);

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

/** owner/name for a GitHub remote, the remote URL otherwise, else null. */
function repositoryIdentity(root)
{
    const result = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
    const url = result.status === 0 ? result.stdout.trim() : "";
    const github = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(url);

    return github ? github[1] : url || null;
}

/** A file of the package folder at the built commit, or null when it is absent. */
function packageFile(context, commit, relative)
{
    const where = context.packagePath ? `${context.packagePath}/${relative}` : relative;
    const listed = git(context.repositoryRoot, ["ls-tree", "--name-only", commit, where]).trim();

    return listed === where ? git(context.repositoryRoot, ["show", `${commit}:${where}`], { encoding: null }) : null;
}

/**
 * What a component set adds to a package build (standard simai.component-set):
 * its passport set.json, copied into the output beside smart/ unchanged, and
 * the api rule its package.json names (simai.api). A package without a
 * passport builds exactly as before.
 */
function setOf(context, commit)
{
    const passport = packageFile(context, commit, "set.json");
    const manifest = packageFile(context, commit, "package.json");
    const api = manifest ? JSON.parse(manifest.toString("utf8"))?.simai?.api : undefined;

    if (!passport)
    {
        return { passport: null, api };
    }

    const value = JSON.parse(passport.toString("utf8"));

    if (value.schema !== "simai.framework.component-set" || value.schema_version !== 1)
    {
        throw new Error("set.json is not a component set passport (simai.framework.component-set, schema_version 1)");
    }

    if (value.id !== context.packageName)
    {
        throw new Error(`set.json is the passport of set ${String(value.id)}, built as ${context.packageName}`);
    }

    return { passport, api };
}

function runWave(waveName, context)
{
    const waveRoot = path.join(context.workspaceRoot, waveName);
    const overlayRoot = path.join(waveRoot, "overlay");
    const diagnosticsRoot = path.join(waveRoot, "diagnostics");
    const outputRoot = path.join(waveRoot, "output", "package", context.packageName);
    const diagnosticsPath = path.join(diagnosticsRoot, "package.json");

    fs.mkdirSync(diagnosticsRoot, { recursive: true });
    const overlay = materializePackageOverlay({
        overlayRoot,
        packageName: context.packageName,
        packagePath: context.packagePath,
        repositoryRoot: context.repositoryRoot,
        revision: context.packageRevision,
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

    const set = setOf(context, overlay.package_revision);

    runNode([
        path.join(__dirname, "run-package-product-build.cjs"),
        "--package", context.packageName,
        "--components", overlay.components.join(","),
        ...(set.api ? ["--api", set.api] : []),
        BUILDER_ROOT,
        path.join(overlayRoot, "src"),
        outputRoot,
        diagnosticsPath,
    ], {
        env: {
            ...process.env,
            SF_BUILDER_DEPENDENCY_ROOT: path.join(waveRoot, "builder-runtime"),
            SF_SOURCE_DEPENDENCY_ROOT: path.join(waveRoot, "source-runtime"),
        },
        label: `${waveName}/package`,
        log: diagnosticsPath,
    });

    const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));

    if (diagnostics.status !== 0 || diagnostics.diagnostics.length !== 0)
    {
        throw new Error(`${waveName}/package has diagnostics`);
    }

    if (set.passport)
    {
        fs.writeFileSync(path.join(outputRoot, "set.json"), set.passport);
    }

    // The product is the package's own folders and the rule file, nothing
    // else, and a set's passport beside them.
    const top = fs.readdirSync(path.join(outputRoot, "smart")).sort();
    const expected = [...overlay.components, path.basename(RULE_FILE), `${path.basename(RULE_FILE)}.gz`].sort();
    const root = fs.readdirSync(outputRoot).sort().join();

    if (JSON.stringify(top) !== JSON.stringify(expected) || root !== (set.passport ? "set.json,smart" : "smart"))
    {
        throw new Error(`${waveName}/package holds ${top.join(", ")}; expected ${expected.join(", ")}`);
    }

    const files = filesUnder(outputRoot);
    // The shared runtime modules and names the package's bundles ask for
    // (run-package-product-build.cjs); the receipt records them.
    const runtimePath = `${diagnosticsPath}.runtime.json`;
    const runtime = fs.existsSync(runtimePath) ? JSON.parse(fs.readFileSync(runtimePath, "utf8")) : null;

    return {
        ...overlay,
        ...(set.passport ? { set: { passport: "set.json", sha256: sha256(set.passport), api: set.api || null } } : {}),
        runtime,
        files,
        files_count: files.length,
        manifest_sha256: sha256(`${JSON.stringify(files)}\n`),
    };
}

function parseArguments(argv)
{
    const options = {};
    const positional = [];

    for (let index = 0; index < argv.length; index += 1)
    {
        if (OPTIONS.includes(argv[index]))
        {
            if (argv[index + 1] === undefined || argv[index] in options)
            {
                return null;
            }

            options[argv[index]] = argv[index + 1];
            index += 1;
        }
        else if (argv[index].startsWith("--"))
        {
            return null;
        }
        else
        {
            positional.push(argv[index]);
        }
    }

    const viaRepository = "--package-source" in options;

    if (!options["--package"] || positional.length !== (viaRepository ? 2 : 3)
        || (!viaRepository && "--package-path" in options)
        || ![...positional, ...(viaRepository ? [options["--package-source"]] : [])].every(value => path.isAbsolute(value)))
    {
        return null;
    }

    const [packageRoot] = viaRepository ? [undefined] : positional;
    const [uiSourceInput, workspaceInput] = positional.slice(viaRepository ? 0 : 1);

    return {
        packageName: options["--package"],
        packagePathOption: options["--package-path"],
        packageRepositoryId: options["--package-repository"],
        packageRevision: options["--package-revision"] || "HEAD",
        packageRoot: packageRoot && path.resolve(packageRoot),
        repositoryOption: viaRepository ? path.resolve(options["--package-source"]) : undefined,
        uiSourceRoot: path.resolve(uiSourceInput),
        workspaceRoot: path.resolve(workspaceInput),
    };
}

function builderState()
{
    const status = spawnSync("git", ["-C", BUILDER_ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });

    return {
        clean: status.status === 0 && status.stdout.trim() === "",
        revision: git(BUILDER_ROOT, ["rev-parse", "HEAD"]).trim(),
        root: BUILDER_ROOT,
    };
}

function main()
{
    const parsed = parseArguments(process.argv.slice(2));

    if (!parsed)
    {
        process.stderr.write(USAGE);
        process.exitCode = 2;
        return;
    }

    let context;

    try
    {
        assertPackageName(parsed.packageName);
        const source = resolvePackageSource({
            packagePath: parsed.packagePathOption,
            packageRoot: parsed.packageRoot,
            repositoryRoot: parsed.repositoryOption,
        });
        context = { ...parsed, ...source };
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n${USAGE}`);
        process.exitCode = 2;
        return;
    }

    if (fs.existsSync(context.workspaceRoot))
    {
        process.stderr.write("workspace root must not exist\n");
        process.exitCode = 2;
        return;
    }

    if ([BUILDER_ROOT, context.repositoryRoot, context.uiSourceRoot].some(root => isWithin(root, context.workspaceRoot)))
    {
        process.stderr.write("workspace root must be outside the builder, the package repository and ui-source\n");
        process.exitCode = 2;
        return;
    }

    fs.mkdirSync(context.workspaceRoot, { recursive: true });
    const report = {
        builder: builderState(),
        node: process.version,
        package: context.packageName,
        package_source: {
            path: context.packagePath,
            repository: context.packageRepositoryId || repositoryIdentity(context.repositoryRoot),
            root: context.repositoryRoot,
        },
        product: "package",
        schema_version: 1,
        status: "PASS",
        ui_source_root: context.uiSourceRoot,
        waves: {},
    };

    try
    {
        report.waves.wave_1 = runWave("wave-1", context);
        report.waves.wave_2 = runWave("wave-2", context);
        const [first, second] = [report.waves.wave_1, report.waves.wave_2];
        report.package_source.revision = first.package_revision;
        report.source_revision = first.source_revision;
        report.components = first.components;
        if (first.set) report.set = first.set;
        report.runtime = first.runtime;
        report.output = path.join("wave-1", "output", "package", context.packageName).split(path.sep).join("/");
        report.products = {
            package: {
                byte_identical: first.manifest_sha256 === second.manifest_sha256
                    && JSON.stringify(first.files) === JSON.stringify(second.files),
                files_count: first.files_count,
                manifest_sha256: first.manifest_sha256,
            },
        };

        if (!report.products.package.byte_identical)
        {
            throw new Error("package waves are not byte-identical");
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
        package: report.package,
        package_source: report.package_source,
        products: report.products,
        report: reportPath,
        source_revision: report.source_revision,
        status: report.status,
    }, null, 2)}\n`);
}

main();
