"use strict";

// The binding tool moves a published pair's revisions into the owner manifests.
// A revision it fails to move leaves the manifest describing two different
// runtimes at once, and the owner repository's own contract test is the first
// thing to notice — which is exactly what happened with entries[].provenance.commit.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const TOOL = path.join(__dirname, "../../scripts/bind-generated-runtime-contracts.py");

function git(root, ...args)
{
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function writeFile(root, relativePath, content)
{
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
}

function repository(root, runtimePath, assetName)
{
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "fixture@example.test");
    git(root, "config", "user.name", "Fixture");
    writeFile(root, `${runtimePath}/${assetName}`, "runtime\n");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "runtime");
    return git(root, "rev-parse", "HEAD");
}

// The tool loads the registry module from the Core root; the owners phase only
// needs the envelope validation, so the fixture provides a permissive one.
const REGISTRY_STUB = `def validate_manifest_envelope(manifest, kind):\n    assert manifest["release"]["commit"]\n`;

function ownerManifest(kind, owner, repositoryUrl, revision, runtimePath, assetName, extra = {})
{
    return {
        schema_id: `simai.framework.${kind}-owner-manifest`,
        schema_version: 1,
        owner,
        defaults: { readiness: "candidate" },
        release: { tag: null, commit: revision, tree: "0".repeat(40), runtime_subtree: "0".repeat(40), archive_sha256: "0".repeat(64) },
        entries: [
            {
                id: `${kind}.thing`,
                kind,
                owner,
                provenance: {
                    repository: repositoryUrl,
                    tag: null,
                    commit: revision,
                    source_refs: [`${owner}@${revision}:${runtimePath}/${assetName}`],
                },
                runtime: { rule_name: "thing", asset_paths: [`${owner}@${revision}:${runtimePath}/${assetName}`] },
                ...extra,
            },
        ],
    };
}

function fixture(previousRevisions)
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-bind-contracts-"));
    const uiRoot = path.join(workspace, "ui");
    const smartRoot = path.join(workspace, "ui-smart");
    const sourceRoot = path.join(workspace, "ui-source");
    const coreRevision = repository(uiRoot, "distr", "core.css");
    const smartRevision = repository(smartRoot, "smart", "thing.js");
    repository(sourceRoot, "src", "index.js");

    writeFile(uiRoot, "scripts/build-framework-registry.py", REGISTRY_STUB);
    for (const kind of ["utility", "component"]) {
        writeFile(
            uiRoot,
            `contracts/owners/${kind}.manifest.json`,
            `${JSON.stringify(ownerManifest(kind, "simai/ui", "https://github.com/simai/ui", previousRevisions.core, "distr", "core.css"), null, 2)}\n`,
        );
    }
    writeFile(
        smartRoot,
        "contracts/owners/smart-component.manifest.json",
        `${JSON.stringify(ownerManifest("smart-component", "simai/ui-smart", "https://github.com/simai/ui-smart", previousRevisions.smart, "smart", "thing.js"), null, 2)}\n`,
    );

    const archive = (root, revision, runtimePath) => crypto
        .createHash("sha256")
        .update(execFileSync("git", ["-C", root, "archive", "--format=tar", ...(runtimePath ? [revision, runtimePath] : [revision])]))
        .digest("hex");
    const entry = (root, revision, runtimePath) => ({
        revision,
        tree: git(root, "rev-parse", `${revision}^{tree}`),
        runtime_path: runtimePath,
        runtime_tree: git(root, "rev-parse", `${revision}:${runtimePath}`),
        candidate_archive: { sha256: archive(root, revision) },
        runtime_archive: { sha256: archive(root, revision, runtimePath) },
    });
    const receipt = path.join(workspace, "receipt.json");
    fs.writeFileSync(receipt, `${JSON.stringify({
        runtime_sources: { core: entry(uiRoot, coreRevision, "distr"), smart: entry(smartRoot, smartRevision, "smart") },
        source_revision: git(sourceRoot, "rev-parse", "HEAD"),
        builder_revision: git(path.join(__dirname, "../.."), "rev-parse", "HEAD"),
    }, null, 2)}\n`);

    return { workspace, uiRoot, smartRoot, sourceRoot, receipt, coreRevision, smartRevision };
}

function bindOwners(context)
{
    return execFileSync("python3", [
        TOOL,
        "--ui-root", context.uiRoot,
        "--smart-root", context.smartRoot,
        "--receipt", context.receipt,
        "--source-root", context.sourceRoot,
        "--phase", "owners",
    ], { encoding: "utf8" });
}

const PREVIOUS = { core: "1".repeat(40), smart: "2".repeat(40) };

test("binding moves every entry provenance to the runtime being published", () => {
    const context = fixture(PREVIOUS);
    bindOwners(context);

    const smart = JSON.parse(fs.readFileSync(path.join(context.smartRoot, "contracts/owners/smart-component.manifest.json"), "utf8"));
    assert.equal(smart.release.commit, context.smartRevision);
    assert.equal(smart.entries[0].provenance.commit, context.smartRevision, "the bare revision moves with the release");
    assert.ok(!JSON.stringify(smart).includes(PREVIOUS.smart), "nothing still names the previous runtime");

    for (const kind of ["utility", "component"]) {
        const manifest = JSON.parse(fs.readFileSync(path.join(context.uiRoot, `contracts/owners/${kind}.manifest.json`), "utf8"));
        assert.equal(manifest.entries[0].provenance.commit, context.coreRevision);
        assert.ok(!JSON.stringify(manifest).includes(PREVIOUS.core));
    }

    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("a superseded revision left anywhere in a manifest stops the binding", () => {
    const context = fixture(PREVIOUS);
    const file = path.join(context.smartRoot, "contracts/owners/smart-component.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    // A field the tool knows nothing about, carrying the revision being replaced.
    manifest.entries[0].verified_against = PREVIOUS.smart;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

    assert.throws(() => bindOwners(context), (error) => /stale revision left in the manifest/.test(String(error.stderr || error.message)));

    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("an entry whose provenance names an unbound repository stops the binding", () => {
    const context = fixture(PREVIOUS);
    const file = path.join(context.smartRoot, "contracts/owners/smart-component.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.entries[0].provenance.repository = "https://github.com/simai/something-else";
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

    assert.throws(() => bindOwners(context), (error) => /unbound provenance repository/.test(String(error.stderr || error.message)));

    fs.rmSync(context.workspace, { recursive: true, force: true });
});
