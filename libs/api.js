"use strict";

// sf-build Node API (docs/developer/architecture-sf-build.md). One entry point
// for the Framework's own builds, for products (Larena, Docara) and for
// external package authors:
//
//   const sfBuild = require("@simai/ui-builder/libs/api");
//   const result = await sfBuild.buildPackage({ config: "sf-build.config.json", out: "public/ui" });
//
// Phase 1 wraps the accepted scripts unchanged, as child processes:
// verify-package-reproducibility.cjs, verify-product-reproducibility.cjs and
// write-package-receipt.py. The Framework's release route keeps calling those
// scripts directly. Every function resolves to the same JSON result the CLI
// prints with --json (schema simai.sf-build.result.v1); it never throws for a
// failed build, a refused receipt or a usage error: `status`, `exit_code` and
// `error.code` say what happened.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { undeclaredRelations } = require("./packageRelations");
const { resolvePackageSource } = require("./packageProduct");
const { buildThemePackage, layThemePackage, themeReceipt } = require("./themePackage");

const {
    CONFIG_FILE_NAME,
    SUPPORTED_KINDS,
    RESERVED_KINDS,
    SfBuildError,
    loadConfig,
    validateConfig,
} = require("./sfBuildConfig");

const BUILDER_ROOT = path.resolve(__dirname, "..");
const SCRIPTS = Object.freeze({
    frameworkVerify: path.join(BUILDER_ROOT, "scripts/verify-product-reproducibility.cjs"),
    packageReceipt: path.join(BUILDER_ROOT, "scripts/write-package-receipt.py"),
    packageVerify: path.join(BUILDER_ROOT, "scripts/verify-package-reproducibility.cjs"),
});
const RESULT_SCHEMA = "simai.sf-build.result.v1";
const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/u;
const FRAMEWORK_PRODUCTS = Object.freeze(["core", "component", "utility", "smart"]);
// What sf-build lays into --out marks the directory as its own: --replace-out
// replaces only a directory that holds the marker (or an empty one).
const MARKERS = Object.freeze({ framework: "build-report.json", package: "package-receipt.json" });
const THEME_MARKER = "theme-receipt.json";

const EXIT_CODES = Object.freeze({
    OK: 0,
    FAILED: 1,
    USAGE: 2,
    REFUSED: 3,
    ENVIRONMENT: 4,
});
const ERROR_EXIT_CODES = Object.freeze({
    BUILD_FAILED: EXIT_CODES.FAILED,
    BUILDER_NOT_A_CHECKOUT: EXIT_CODES.ENVIRONMENT,
    CONFIG_INVALID: EXIT_CODES.USAGE,
    INTERNAL: EXIT_CODES.FAILED,
    KIND_NOT_SUPPORTED: EXIT_CODES.USAGE,
    NOT_REPRODUCIBLE: EXIT_CODES.FAILED,
    OUT_CONFLICT: EXIT_CODES.USAGE,
    OUTPUT_MISMATCH: EXIT_CODES.FAILED,
    RECEIPT_REFUSED: EXIT_CODES.REFUSED,
    TOOL_MISSING: EXIT_CODES.ENVIRONMENT,
    UNSUPPORTED_NODE: EXIT_CODES.ENVIRONMENT,
    USAGE: EXIT_CODES.USAGE,
    WORKSPACE_CONFLICT: EXIT_CODES.USAGE,
});

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

/** The files of a tree in the order and form the verifiers hash them. */
function filesUnder(root, current = root)
{
    return fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : 1)
        .flatMap(entry => {
            const absolute = path.join(current, entry.name);

            if (entry.isSymbolicLink())
            {
                throw new SfBuildError("OUTPUT_MISMATCH", `output symlink is forbidden: ${absolute}`);
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

function manifestSha256(root)
{
    return sha256(`${JSON.stringify(filesUnder(root))}\n`);
}

function copyTree(from, to)
{
    fs.mkdirSync(to, { recursive: true });

    for (const entry of fs.readdirSync(from, { withFileTypes: true }))
    {
        const source = path.join(from, entry.name);
        const destination = path.join(to, entry.name);

        if (entry.isDirectory())
        {
            copyTree(source, destination);
        }
        else if (entry.isFile())
        {
            fs.copyFileSync(source, destination);
        }
        else
        {
            throw new SfBuildError("OUTPUT_MISMATCH", `not a regular file: ${source}`);
        }
    }
}

function run(command, args, options = {})
{
    return new Promise(resolve => {
        const child = spawn(command, args, {
            cwd: options.cwd || BUILDER_ROOT,
            env: options.env || process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", chunk => stdout.push(chunk));
        child.stderr.on("data", chunk => stderr.push(chunk));
        child.on("error", error => resolve({ error, status: null, stderr: "", stdout: "" }));
        child.on("close", status => resolve({
            status,
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdout: Buffer.concat(stdout).toString("utf8"),
        }));
    });
}

function requireTool(command, args, label)
{
    const probe = spawnSync(command, args, { encoding: "utf8" });

    if (probe.error || probe.status !== 0)
    {
        throw new SfBuildError("TOOL_MISSING", `${label} is required: ${command} ${args.join(" ")} failed`);
    }
}

function requireEnvironment({ python = false } = {})
{
    const [major, minor] = process.versions.node.split(".").map(Number);

    if (major < 20 || (major === 20 && minor < 19))
    {
        throw new SfBuildError("UNSUPPORTED_NODE", `Node.js >=20.19.0 is required, this is ${process.version}`);
    }

    requireTool("git", ["--version"], "git");

    if (python)
    {
        requireTool("python3", ["--version"], "python3 (the package receipt)");
    }

    // The verifiers record the builder's own commit; phase 1 needs a checkout.
    const head = spawnSync("git", ["-C", BUILDER_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });

    if (head.status !== 0)
    {
        throw new SfBuildError(
            "BUILDER_NOT_A_CHECKOUT",
            `the builder at ${BUILDER_ROOT} is not a git checkout; this version records the builder commit in every report and runs only from a checkout (a local path or a git clone)`,
        );
    }
}

function builderIdentity()
{
    const manifest = JSON.parse(fs.readFileSync(path.join(BUILDER_ROOT, "package.json"), "utf8"));
    const head = spawnSync("git", ["-C", BUILDER_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });

    return {
        name: manifest.name,
        revision: head.status === 0 ? head.stdout.trim() : null,
        root: BUILDER_ROOT,
        version: manifest.version,
    };
}

/**
 * Merge, in order of precedence: explicit options, environment
 * (SF_BUILD_UI_SOURCE, SF_BUILD_UI), the configuration file. Paths in options
 * are resolved against `cwd`; paths in the file against the file's directory.
 */
function resolveOptions(options, { discoverConfig })
{
    const cwd = path.resolve(options.cwd || process.cwd());
    const env = options.env || process.env;
    let configFile = options.config ? path.resolve(cwd, options.config) : undefined;

    if (!configFile && discoverConfig && fs.existsSync(path.join(cwd, CONFIG_FILE_NAME)))
    {
        configFile = path.join(cwd, CONFIG_FILE_NAME);
    }

    const loaded = configFile ? loadConfig(configFile) : null;
    const fromFile = loaded ? loaded.resolved : {};
    const asPath = value => value === undefined || value === null || value === "" ? undefined : path.resolve(cwd, value);
    const fromEnv = {
        ui: asPath(env.SF_BUILD_UI),
        uiSource: asPath(env.SF_BUILD_UI_SOURCE),
    };
    const pathKeys = ["out", "packageRoot", "report", "ui", "uiSource", "workspace"];
    const resolved = { configFile: loaded ? loaded.file : null };

    for (const key of [...pathKeys, "kind", "name", "packageRepository", "packageRevision"])
    {
        const given = options[key];

        if (given !== undefined && given !== null)
        {
            resolved[key] = pathKeys.includes(key) ? asPath(given) : given;
        }
        else if (fromEnv[key] !== undefined)
        {
            resolved[key] = fromEnv[key];
        }
        else
        {
            resolved[key] = fromFile[key];
        }
    }

    resolved.keepWorkspace = Boolean(options.keepWorkspace);
    resolved.replaceOut = Boolean(options.replaceOut);
    resolved.requireLegacyCompatibility = Boolean(options.requireLegacyCompatibility);
    resolved.onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

    return resolved;
}

function assertKind(kind)
{
    const value = kind === undefined ? "components" : kind;

    if (RESERVED_KINDS.includes(value))
    {
        throw new SfBuildError("KIND_NOT_SUPPORTED", `package kind ${value} is not built yet; this version builds ${SUPPORTED_KINDS.join(", ")}`, { kind: value });
    }

    if (!SUPPORTED_KINDS.includes(value))
    {
        throw new SfBuildError("USAGE", `unknown package kind ${String(value)}; known: ${[...SUPPORTED_KINDS, ...RESERVED_KINDS].join(", ")}`);
    }

    return value;
}

function required(value, what)
{
    if (value === undefined)
    {
        throw new SfBuildError("USAGE", `${what} is required`);
    }

    return value;
}

/** Refuse an --out that would clobber something sf-build did not lay. */
function checkOut(out, marker, replaceOut, protectedRoots)
{
    if (!out)
    {
        return;
    }

    for (const [label, root] of protectedRoots)
    {
        if (root && (isWithin(out, root) || isWithin(root, out) && label === "workspace"))
        {
            throw new SfBuildError("OUT_CONFLICT", `--out ${out} must not hold, or lie in, the ${label} ${root}`);
        }
    }

    if (!fs.existsSync(out))
    {
        return;
    }

    const stat = fs.lstatSync(out);

    if (stat.isSymbolicLink() || !stat.isDirectory())
    {
        throw new SfBuildError("OUT_CONFLICT", `--out ${out} exists and is not a directory`);
    }

    const entries = fs.readdirSync(out);

    if (entries.length === 0)
    {
        return;
    }

    if (!replaceOut)
    {
        throw new SfBuildError("OUT_CONFLICT", `--out ${out} exists and is not empty; pass --replace-out to replace an earlier sf-build output`);
    }

    if (!entries.includes(marker))
    {
        throw new SfBuildError("OUT_CONFLICT", `--out ${out} holds no ${marker}; sf-build replaces only a directory it laid itself`);
    }
}

function checkWorkspace(workspace)
{
    if (workspace && fs.existsSync(workspace))
    {
        throw new SfBuildError("WORKSPACE_CONFLICT", `--workspace ${workspace} must not exist; every run needs a new one`);
    }
}

function newWorkspace(given)
{
    if (given)
    {
        return { root: given, temporary: false };
    }

    return {
        root: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sf-build-")), "workspace"),
        temporary: true,
    };
}

function dropWorkspace(workspace)
{
    if (workspace.temporary)
    {
        fs.rmSync(path.dirname(workspace.root), { force: true, recursive: true });
        return false;
    }

    return true;
}

/** Lay `fill(staging)` at `out` in one rename, after `check(staging)` passes. */
function layOut(out, fill, check)
{
    const parent = path.dirname(out);
    fs.mkdirSync(parent, { recursive: true });
    const staging = path.join(parent, `.${path.basename(out)}.sf-build-${process.pid}`);
    fs.rmSync(staging, { force: true, recursive: true });

    try
    {
        fill(staging);
        check(staging);
    }
    catch (error)
    {
        fs.rmSync(staging, { force: true, recursive: true });
        throw error;
    }

    fs.rmSync(out, { force: true, recursive: true });
    fs.renameSync(staging, out);
}

function readReport(workspaceRoot)
{
    const reportPath = path.join(workspaceRoot, "report.json");

    return fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
}

function verifierFailure(label, execution, report)
{
    if (report && report.status === "FAIL")
    {
        const first = String(report.error || "").split("\n")[0].replace(/^Error: /u, "");
        const code = /not byte-identical/u.test(first) ? "NOT_REPRODUCIBLE" : "BUILD_FAILED";

        return new SfBuildError(code, `${label}: ${first}`);
    }

    if (execution.status === 2)
    {
        return new SfBuildError("USAGE", `${label}: ${execution.stderr.trim().split("\n")[0]}`);
    }

    return new SfBuildError("BUILD_FAILED", `${label} exited with ${String(execution.status)}: ${(execution.stderr || String(execution.error || "")).trim().split("\n").slice(-3).join(" ")}`);
}

function result(command, fields)
{
    return {
        schema: RESULT_SCHEMA,
        command,
        status: "PASS",
        exit_code: EXIT_CODES.OK,
        ...fields,
        error: null,
    };
}

function failure(command, error, fields = {})
{
    const known = error instanceof SfBuildError;
    const code = known ? error.code : "INTERNAL";

    return {
        schema: RESULT_SCHEMA,
        command,
        status: "FAIL",
        exit_code: ERROR_EXIT_CODES[code] === undefined ? EXIT_CODES.FAILED : ERROR_EXIT_CODES[code],
        ...fields,
        error: {
            code,
            message: known ? error.message : String(error && error.stack ? error.stack : error),
            ...(known && error.details !== undefined ? { details: error.details } : {}),
        },
    };
}

// --- package -----------------------------------------------------------------

async function runPackageVerifier(resolved, workspace)
{
    const args = [
        SCRIPTS.packageVerify,
        resolved.packageRoot,
        resolved.uiSource,
        workspace.root,
        "--package", resolved.name,
    ];

    if (resolved.packageRevision) args.push("--package-revision", resolved.packageRevision);
    if (resolved.packageRepository) args.push("--package-repository", resolved.packageRepository);

    resolved.onProgress(`building package ${resolved.name} twice in ${workspace.root}`);
    const execution = await run(process.execPath, args);
    const report = readReport(workspace.root);

    if (execution.status !== 0 || !report || report.status !== "PASS")
    {
        throw verifierFailure("verify-package-reproducibility", execution, report);
    }

    return report;
}

async function runReceipt(reportPath, ui, onProgress)
{
    const args = [SCRIPTS.packageReceipt, "--report", reportPath];

    if (ui) args.push("--ui", ui);

    onProgress("writing the package receipt");
    const execution = await run("python3", args);
    const warnings = execution.stderr.split("\n")
        .filter(line => line.startsWith("PACKAGE_RECEIPT_WARNING"))
        .map(line => line.replace(/^PACKAGE_RECEIPT_WARNING\s+\S+\s+/u, ""));

    if (execution.status !== 0)
    {
        const said = execution.stderr.split("\n").filter(line => line && !line.startsWith("PACKAGE_RECEIPT_WARNING")).join("\n")
            .replace(/^PACKAGE_RECEIPT_ERROR\s+\S+\s+/u, "");

        throw new SfBuildError(
            execution.status === 1 ? "RECEIPT_REFUSED" : "BUILD_FAILED",
            said || `write-package-receipt.py exited with ${String(execution.status)}`,
        );
    }

    const workspace = path.dirname(reportPath);
    const receiptPath = path.join(workspace, "package-receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

    return { receipt, receiptPath, archivePath: path.join(workspace, receipt.output.archive), warnings };
}

/** Lay <out>/smart, package-receipt.json and package-<name>.tar. */
function layPackage(out, report, workspaceRoot, receiptFiles)
{
    const { receipt, receiptPath, archivePath } = receiptFiles;

    layOut(out, staging => {
        copyTree(path.join(workspaceRoot, report.output, "smart"), path.join(staging, "smart"));
        fs.copyFileSync(receiptPath, path.join(staging, "package-receipt.json"));
        fs.copyFileSync(archivePath, path.join(staging, receipt.output.archive));
    }, staging => {
        // The laid smart/ hashes, from the output root, to what the receipt pinned.
        const laid = filesUnder(staging).filter(item => item.path.startsWith("smart/"));

        if (sha256(`${JSON.stringify(laid)}\n`) !== receipt.output.manifest_sha256
            || sha256(fs.readFileSync(path.join(staging, receipt.output.archive))) !== receipt.output.archive_sha256)
        {
            throw new SfBuildError("OUTPUT_MISMATCH", `the files laid in ${staging} are not the ones the receipt pins`);
        }
    });

    return {
        archive: path.join(out, receipt.output.archive),
        receipt: path.join(out, "package-receipt.json"),
        root: out,
        runtime: path.join(out, "smart"),
    };
}

function packageFields(resolved)
{
    return {
        builder: builderIdentity(),
        config: resolved.configFile,
        kind: resolved.kind,
        package: resolved.name,
    };
}

function preparePackage(options, { needsOutOrWorkspace })
{
    const resolved = resolveOptions(options, { discoverConfig: true });
    resolved.kind = assertKind(resolved.kind);
    required(resolved.name, "the package name (--name or package.name)");

    if (!PACKAGE_NAME.test(resolved.name))
    {
        throw new SfBuildError("USAGE", `package name must match ${PACKAGE_NAME}: ${resolved.name}`);
    }

    required(resolved.packageRoot, "the package folder (--package-root or package.path)");
    required(resolved.uiSource, "a ui-source checkout (--ui-source, SF_BUILD_UI_SOURCE or framework.source)");

    if (needsOutOrWorkspace && !resolved.out && !resolved.workspace)
    {
        throw new SfBuildError("USAGE", "give --out (where the package is laid) or --workspace (where the build stays)");
    }

    return resolved;
}

async function packageFlow(command, options)
{
    let resolved;
    let workspace;
    const withOut = command === "package";

    try
    {
        resolved = preparePackage(options, { needsOutOrWorkspace: withOut });
        requireEnvironment({ python: withOut });
        checkWorkspace(resolved.workspace);

        if (withOut)
        {
            checkOut(resolved.out, MARKERS.package, resolved.replaceOut, [
                ["builder", BUILDER_ROOT],
                ["package folder", resolved.packageRoot],
                ["ui-source checkout", resolved.uiSource],
                ["workspace", resolved.workspace],
            ]);
        }

        // Read from the source, so a warning, not a refusal: see packageRelations.js.
        const relationWarnings = undeclaredRelations(resolved);
        workspace = newWorkspace(resolved.workspace);
        const report = await runPackageVerifier(resolved, workspace);
        const summary = {
            ...packageFields(resolved),
            components: report.components,
            output: {
                files_count: report.products.package.files_count,
                manifest_sha256: report.products.package.manifest_sha256,
            },
            package_source: {
                path: report.package_source.path,
                repository: report.package_source.repository,
                revision: report.package_source.revision,
            },
            source_revision: report.source_revision,
        };

        if (!withOut)
        {
            const kept = resolved.keepWorkspace || !workspace.temporary ? true : dropWorkspace(workspace);

            return result(command, {
                ...summary,
                target: "package",
                warnings: relationWarnings,
                workspace: { kept, report: kept ? path.join(workspace.root, "report.json") : null, root: workspace.root },
            });
        }

        const receiptFiles = await runReceipt(path.join(workspace.root, "report.json"), resolved.ui, resolved.onProgress);
        let out = null;

        if (resolved.out)
        {
            resolved.onProgress(`laying the package into ${resolved.out}`);
            out = layPackage(resolved.out, report, workspace.root, receiptFiles);
        }

        const { receipt } = receiptFiles;
        const kept = !out || resolved.keepWorkspace || !workspace.temporary ? true : dropWorkspace(workspace);

        return result(command, {
            ...summary,
            framework: receipt.framework,
            out,
            output: {
                ...summary.output,
                archive: receipt.output.archive,
                archive_sha256: receipt.output.archive_sha256,
            },
            package_reference: receipt.package_reference.status,
            warnings: [...relationWarnings, ...(receiptFiles.warnings || [])],
            workspace: {
                kept,
                receipt: kept ? receiptFiles.receiptPath : null,
                report: kept ? path.join(workspace.root, "report.json") : null,
                root: workspace.root,
            },
        });
    }
    catch (error)
    {
        return failure(command, error, {
            ...(resolved ? { kind: resolved.kind, package: resolved.name } : {}),
            ...(command === "verify" ? { target: "package" } : {}),
            ...(workspace ? { workspace: { kept: true, report: path.join(workspace.root, "report.json"), root: workspace.root } } : {}),
        });
    }
}

/**
 * Build a component package twice over its pinned Framework source, write its
 * receipt and, with `out`, lay `<out>/smart`, `package-receipt.json` and
 * `package-<name>.tar`.
 *
 * options: config, cwd, env, name, kind, packageRoot, packageRevision,
 * packageRepository, uiSource, ui, out, replaceOut, workspace, keepWorkspace,
 * onProgress(message).
 */
function buildPackage(options = {})
{
    if (kindOf(options) === "theme")
    {
        return themeFlow("package", options);
    }

    return packageFlow("package", options);
}

// The kind asked for, before the full resolution: a theme package takes its
// own flow (libs/themePackage.js), no webpack and no overlay.
function kindOf(options)
{
    try
    {
        return resolveOptions(options, { discoverConfig: true }).kind;
    }
    catch (error)
    {
        return options.kind;
    }
}

async function themeFlow(command, options)
{
    let resolved;
    let workspace;

    try
    {
        resolved = resolveOptions(options, { discoverConfig: true });
        resolved.kind = assertKind(resolved.kind);
        required(resolved.name, "the package name (--name or package.name)");

        if (!PACKAGE_NAME.test(resolved.name))
        {
            throw new SfBuildError("USAGE", `package name must match ${PACKAGE_NAME}: ${resolved.name}`);
        }

        required(resolved.packageRoot, "the package folder (--package-root or package.path)");
        required(resolved.uiSource, "a ui-source checkout (--ui-source, SF_BUILD_UI_SOURCE or framework.source)");
        requireEnvironment({ python: false });
        checkWorkspace(resolved.workspace);
        checkOut(resolved.out, THEME_MARKER, resolved.replaceOut, [
            ["builder", BUILDER_ROOT],
            ["package folder", resolved.packageRoot],
            ["ui-source checkout", resolved.uiSource],
            ["workspace", resolved.workspace],
        ]);

        const { repositoryRoot, packagePath } = resolvePackageSource({ packageRoot: resolved.packageRoot });
        workspace = newWorkspace(resolved.workspace);
        fs.mkdirSync(workspace.root, { recursive: true });
        resolved.onProgress(`building the theme ${resolved.name} twice`);
        const built = await buildThemePackage({
            repositoryRoot,
            packagePath,
            revision: resolved.packageRevision || "HEAD",
            packageName: resolved.name,
            uiSourceRoot: resolved.uiSource,
            workspace: workspace.root,
        });
        const receipt = themeReceipt(built, {
            packageName: resolved.name,
            packagePath,
            repository: resolved.packageRepository || null,
            builderRevision: builderIdentity().revision,
        });
        let out = null;

        if (resolved.out)
        {
            if (fs.existsSync(resolved.out))
            {
                fs.rmSync(resolved.out, { recursive: true });
            }

            out = layThemePackage(resolved.out, built, receipt);
        }

        const kept = resolved.keepWorkspace || !workspace.temporary ? true : dropWorkspace(workspace);

        return result(command, {
            ...packageFields(resolved),
            out,
            output: receipt.output,
            package_source: receipt.package_source,
            source_revision: built.sourceRevision,
            warnings: [],
            workspace: { kept, root: workspace.root },
        });
    }
    catch (error)
    {
        return failure(command, error instanceof SfBuildError ? error : new SfBuildError("BUILD_FAILED", error.message), {
            ...(resolved ? { kind: resolved.kind, package: resolved.name } : {}),
        });
    }
}

/** The two-wave check of a package alone: no receipt, nothing laid. */
function verifyPackage(options = {})
{
    return packageFlow("verify", options);
}

// --- framework ---------------------------------------------------------------

async function frameworkFlow(command, options)
{
    let resolved;
    let workspace;
    const withOut = command === "framework";

    try
    {
        resolved = resolveOptions(options, { discoverConfig: false });
        required(resolved.uiSource, "a ui-source checkout (--ui-source, SF_BUILD_UI_SOURCE or framework.source)");

        if (withOut && !resolved.out && !resolved.workspace)
        {
            throw new SfBuildError("USAGE", "give --out (where the Framework is laid) or --workspace (where the build stays)");
        }

        requireEnvironment();
        checkWorkspace(resolved.workspace);

        if (withOut)
        {
            checkOut(resolved.out, MARKERS.framework, resolved.replaceOut, [
                ["builder", BUILDER_ROOT],
                ["ui-source checkout", resolved.uiSource],
                ["workspace", resolved.workspace],
            ]);
        }

        workspace = newWorkspace(resolved.workspace);
        const args = [SCRIPTS.frameworkVerify, resolved.uiSource, workspace.root];

        if (resolved.requireLegacyCompatibility) args.push("--require-legacy-compatibility");

        resolved.onProgress(`building the Framework twice in ${workspace.root}`);
        const execution = await run(process.execPath, args);
        const report = readReport(workspace.root);

        if (execution.status !== 0 || !report || report.status !== "PASS")
        {
            throw verifierFailure("verify-product-reproducibility", execution, report);
        }

        const products = Object.fromEntries(FRAMEWORK_PRODUCTS.map(product => [product, {
            files_count: report.products[product].files_count,
            manifest_sha256: report.products[product].manifest_sha256,
        }]));
        let out = null;

        if (withOut && resolved.out)
        {
            resolved.onProgress(`laying the Framework into ${resolved.out}`);
            const output = path.join(workspace.root, "wave-1", "output");
            layOut(resolved.out, staging => {
                for (const product of FRAMEWORK_PRODUCTS)
                {
                    copyTree(path.join(output, product), path.join(staging, product));
                }

                fs.copyFileSync(path.join(workspace.root, "report.json"), path.join(staging, MARKERS.framework));
            }, staging => {
                for (const product of FRAMEWORK_PRODUCTS)
                {
                    if (manifestSha256(path.join(staging, product)) !== products[product].manifest_sha256)
                    {
                        throw new SfBuildError("OUTPUT_MISMATCH", `the laid ${product} is not the one the report hashed`);
                    }
                }
            });
            out = {
                products: Object.fromEntries(FRAMEWORK_PRODUCTS.map(product => [product, path.join(resolved.out, product)])),
                report: path.join(resolved.out, MARKERS.framework),
                root: resolved.out,
            };
        }

        const kept = resolved.keepWorkspace || !workspace.temporary || (withOut && !out) ? true : dropWorkspace(workspace);

        return result(command, {
            builder: builderIdentity(),
            legacy_compatibility: report.legacy_compatibility.enabled,
            out,
            products,
            ...(withOut ? {} : { target: "framework" }),
            ui_source: resolved.uiSource,
            workspace: { kept, report: kept ? path.join(workspace.root, "report.json") : null, root: workspace.root },
        });
    }
    catch (error)
    {
        return failure(command, error, {
            ...(withOut ? {} : { target: "framework" }),
            ...(workspace ? { workspace: { kept: true, report: path.join(workspace.root, "report.json"), root: workspace.root } } : {}),
        });
    }
}

/**
 * Build the Framework (Core, Component, Utility, Smart) from a ui-source
 * checkout twice and, with `out`, lay wave 1 as `<out>/{core,component,
 * utility,smart}` plus `build-report.json`: the `--output` the Framework's
 * release route (publish-framework-release.sh) takes.
 *
 * options: cwd, env, config (framework.source only), uiSource, out,
 * replaceOut, workspace, keepWorkspace, requireLegacyCompatibility, onProgress.
 */
function buildFramework(options = {})
{
    return frameworkFlow("framework", options);
}

/** The two-wave check of the Framework alone: nothing laid. */
function verifyFramework(options = {})
{
    return frameworkFlow("verify", options);
}

// --- receipt -----------------------------------------------------------------

/**
 * Write the receipt of a passing package build (`report`: its report.json)
 * beside the report and, with `out`, lay the package as buildPackage does.
 *
 * options: cwd, env, report, ui, out, replaceOut, onProgress.
 */
async function writeReceipt(options = {})
{
    let resolved;

    try
    {
        resolved = resolveOptions(options, { discoverConfig: false });
        required(resolved.report, "the build report (--report)");
        requireEnvironment({ python: true });
        const report = readReport(path.dirname(resolved.report));

        if (path.basename(resolved.report) !== "report.json" || !report)
        {
            throw new SfBuildError("USAGE", `--report must name the report.json of a package build: ${resolved.report}`);
        }

        const workspaceRoot = path.dirname(resolved.report);
        checkOut(resolved.out, MARKERS.package, resolved.replaceOut, [
            ["builder", BUILDER_ROOT],
            ["workspace", workspaceRoot],
        ]);
        const receiptFiles = await runReceipt(resolved.report, resolved.ui, resolved.onProgress);
        const out = resolved.out ? layPackage(resolved.out, report, workspaceRoot, receiptFiles) : null;
        const { receipt } = receiptFiles;

        return result("receipt", {
            builder: builderIdentity(),
            framework: receipt.framework,
            kind: "components",
            out,
            output: {
                archive: receipt.output.archive,
                archive_sha256: receipt.output.archive_sha256,
                files_count: receipt.output.files_count,
                manifest_sha256: receipt.output.manifest_sha256,
            },
            package: receipt.package,
            package_reference: receipt.package_reference.status,
            receipt: receiptFiles.receiptPath,
            warnings: receiptFiles.warnings,
        });
    }
    catch (error)
    {
        return failure("receipt", error);
    }
}

module.exports = {
    BUILDER_ROOT,
    ERROR_EXIT_CODES,
    EXIT_CODES,
    RESULT_SCHEMA,
    SfBuildError,
    buildFramework,
    buildPackage,
    loadConfig,
    validateConfig,
    verifyFramework,
    verifyPackage,
    writeReceipt,
};
