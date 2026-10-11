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

// ---------------------------------------------------------------------------
// Lock v2: one ui build commit is the release, Smart is in ui/distr/smart, and
// ui-smart is kept as a byte-identical mirror for v1 readers.

const RECEIPT_TOOL = path.join(__dirname, "../../scripts/write-release-receipt.py");

// Enough of ui's registry module for both phases: the lock is checked for the
// identity each version promises, nothing more (ui's own suite checks the rest).
const REGISTRY_STUB_V2 = [
    "import re",
    "def validate_manifest_envelope(manifest, kind):",
    "    assert manifest['release']['commit']",
    "def relation_id(name, rule_kinds):",
    "    return 'smart.' + name[3:] if name.startswith('cl-') else rule_kinds[name] + '.' + name",
    "def validate_lock(lock):",
    "    if lock['schema_version'] == 2:",
    "        assert re.fullmatch(r'ui-[0-9a-f]{12}', lock['compatibility_id'])",
    "        assert lock['compatibility_id'] == 'ui-' + lock['runtime_sources']['core']['revision'][:12]",
    "    else:",
    "        sources = lock['runtime_sources']",
    "        assert lock['compatibility_id'] == 'ui-%s-smart-%s' % (sources['ui']['commit'][:12], sources['ui-smart']['commit'][:12])",
    "",
].join("\n");

function commitAll(root, message)
{
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", message);
    return git(root, "rev-parse", "HEAD");
}

function smartManifest(revision, coreRevision)
{
    const manifest = ownerManifest("smart-component", "simai/ui-smart", "https://github.com/simai/ui-smart", revision, "smart", "thing/js/thing.js");
    manifest.owner = { id: "simai/ui-smart", repository: "https://github.com/simai/ui-smart", manifest_path: "contracts/owners/smart-component.manifest.json" };
    manifest.inventory = { source: `simai/ui-smart@${revision}:smart`, selector: "*/js/*.js", expected: 1 };
    manifest.entries[0].provenance.source_refs.push(`simai/ui@${coreRevision}:distr/rule/rule.json#name=cl-thing`);
    manifest.entries[0].documentation_refs = [`simai/ui-smart@${revision}:README.md`];
    manifest.entries[0].runtime.rule_name = "cl-thing";
    manifest.defaults = { lifecycle: "released", readiness: { status: "discoverable", safe_to_suggest: false, profiles: ["plain-assets-v1"], blockers: [] } };
    return manifest;
}

function v2Fixture()
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-bind-v2-"));
    const uiRoot = path.join(workspace, "ui");
    const mirrorRoot = path.join(workspace, "ui-smart");
    const sourceRoot = path.join(workspace, "ui-source");
    const previousCore = repository(uiRoot, "distr/core", "core.css");
    const previousSmart = repository(mirrorRoot, "smart/thing/js", "thing.js");
    repository(sourceRoot, "src", "index.js");
    writeFile(uiRoot, "scripts/build-framework-registry.py", REGISTRY_STUB_V2);
    writeFile(uiRoot, "README.md", "ui\n");
    for (const kind of ["utility", "component", "recipe"]) {
        const manifest = ownerManifest(kind, "simai/ui", "https://github.com/simai/ui", previousCore, "distr", "core/core.css");
        manifest.inventory = { expected: { rules: 3, entries: 2 } };
        writeFile(uiRoot, `contracts/owners/${kind}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    writeFile(mirrorRoot, "README.md", "ui-smart\n");
    writeFile(mirrorRoot, "contracts/owners/smart-component.manifest.json", `${JSON.stringify(smartManifest(previousSmart, previousCore), null, 2)}\n`);
    commitAll(uiRoot, "metadata");
    commitAll(mirrorRoot, "metadata");
    return { workspace, uiRoot, mirrorRoot, sourceRoot };
}

// The Smart rules a build lays into distr/rule/rule.json.
const THING_RULE = { name: "cl-thing", type: "smart", mode: "smart", js: true, tags: ["sf-thing"] };

// What publish-framework-release.sh does around the binder, step for step.
function publish(context, coreBytes, smartBytes, rules = [THING_RULE])
{
    writeFile(context.uiRoot, "distr/core/core.css", coreBytes);
    writeFile(context.uiRoot, "distr/rule/rule.json", `${JSON.stringify(rules, null, 2)}\n`);
    writeFile(context.uiRoot, "distr/smart/thing/js/thing.js", smartBytes);
    const release = commitAll(context.uiRoot, "Build");
    // The mirror receives distr/smart as it is (rsync --delete).
    fs.rmSync(path.join(context.mirrorRoot, "smart"), { recursive: true, force: true });
    fs.cpSync(path.join(context.uiRoot, "distr/smart"), path.join(context.mirrorRoot, "smart"), { recursive: true });
    if (git(context.mirrorRoot, "status", "--porcelain")) commitAll(context.mirrorRoot, "Build");
    const receipt = path.join(context.workspace, `receipt-${release.slice(0, 12)}.json`);
    execFileSync("python3", [RECEIPT_TOOL, "--ui-root", context.uiRoot, "--mirror-root", context.mirrorRoot, "--source-root", context.sourceRoot, "--output", receipt]);
    const bind = (phase) => execFileSync("python3", [
        TOOL, "--ui-root", context.uiRoot, "--smart-root", context.uiRoot, "--mirror-root", context.mirrorRoot,
        "--receipt", receipt, "--source-root", context.sourceRoot, "--phase", phase,
    ], { encoding: "utf8" });
    const said = bind("owners");
    if (git(context.mirrorRoot, "status", "--porcelain")) commitAll(context.mirrorRoot, "Bind Smart metadata");
    const written = JSON.parse(bind("reference").trim().split("\n").pop());
    commitAll(context.uiRoot, "Bind the registry");
    const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    return {
        release,
        said,
        receipt: read(context.workspace, path.basename(receipt)),
        written,
        lock: read(context.uiRoot, `contracts/releases/${written.compatibility_id}.lock.json`),
        alias: written.pair ? read(context.uiRoot, `contracts/releases/${written.pair}.lock.json`) : null,
        smart: read(context.uiRoot, "contracts/owners/smart-component.manifest.json"),
        mirror: read(context.mirrorRoot, "contracts/owners/smart-component.manifest.json"),
    };
}

test("v2: the release is one ui build commit, named ui-<12>, with no template lock", () => {
    const context = v2Fixture();
    const result = publish(context, "core-1\n", "smart-1\n");
    const mirrorCommit = git(context.mirrorRoot, "log", "-1", "--format=%H", "--", "smart");

    assert.equal(result.written.compatibility_id, `ui-${result.release.slice(0, 12)}`);
    assert.equal(result.lock.schema_version, 2);
    assert.deepEqual(Object.keys(result.lock.runtime_sources).sort(), ["core", "smart"]);
    for (const [side, runtimePath] of [["core", "distr"], ["smart", "distr/smart"]]) {
        const source = result.lock.runtime_sources[side];
        assert.equal(source.owner, "simai/ui");
        assert.equal(source.revision, result.release, `${side} is the same revision`);
        assert.equal(source.commit, result.release, `${side} was written by the release`);
        assert.equal(source.runtime_path, runtimePath);
        assert.equal(source.runtime_tree, git(context.uiRoot, "rev-parse", `${result.release}:${runtimePath}`));
    }
    assert.equal(result.lock.mirror.commit, mirrorCommit);
    assert.equal(result.lock.mirror.runtime_tree, result.lock.runtime_sources.smart.runtime_tree, "byte-identical copies");
    assert.equal(result.lock.pair, `ui-${result.release.slice(0, 12)}-smart-${mirrorCommit.slice(0, 12)}`);
    assert.equal(result.lock.inventory.smart_components, 1, "inventory is read from the manifests");

    // The v1 alias is what a reader pinning ui and ui-smart resolves.
    assert.equal(result.alias.schema_version, 1);
    assert.equal(result.alias.compatibility_id, result.lock.pair);
    assert.equal(result.alias.runtime_sources.ui.commit, result.release);
    assert.equal(result.alias.runtime_sources["ui-smart"].commit, mirrorCommit);

    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: the Smart manifest moves into ui, seeded from the mirror's", () => {
    const context = v2Fixture();
    const result = publish(context, "core-1\n", "smart-1\n");
    const mirrorCommit = result.lock.mirror.commit;

    assert.equal(result.smart.owner.id, "simai/ui");
    assert.equal(result.smart.release.commit, result.release);
    assert.equal(result.smart.release.runtime_subtree, result.lock.runtime_sources.smart.runtime_tree);
    assert.equal(result.smart.inventory.source, `simai/ui@${result.release}:distr/smart`);
    const entry = result.smart.entries[0];
    assert.equal(entry.owner, "simai/ui");
    assert.equal(entry.provenance.repository, "https://github.com/simai/ui");
    assert.equal(entry.provenance.commit, result.release);
    assert.deepEqual(entry.runtime.asset_paths, [`simai/ui@${result.release}:distr/smart/thing/js/thing.js`]);
    assert.ok(entry.provenance.source_refs.includes(`simai/ui@${result.release}:distr/rule/rule.json#name=cl-thing`));
    assert.deepEqual(entry.documentation_refs, [`simai/ui@${result.release}:README.md`]);
    assert.ok(!JSON.stringify(result.smart).includes("ui-smart"), "the ui-owned manifest names ui only");

    // The mirror keeps its own manifest, bound to the mirror commit.
    assert.equal(result.mirror.owner.id, "simai/ui-smart");
    assert.equal(result.mirror.release.commit, mirrorCommit);
    assert.deepEqual(result.mirror.entries[0].runtime.asset_paths, [`simai/ui-smart@${mirrorCommit}:smart/thing/js/thing.js`]);
    assert.ok(result.mirror.entries[0].provenance.source_refs.includes(`simai/ui@${result.release}:distr/rule/rule.json#name=cl-thing`));

    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: Smart bytes that did not move keep the build commit that wrote them", () => {
    const context = v2Fixture();
    const first = publish(context, "core-1\n", "smart-1\n");
    const second = publish(context, "core-2\n", "smart-1\n");

    assert.notEqual(second.release, first.release);
    assert.equal(second.written.compatibility_id, `ui-${second.release.slice(0, 12)}`);
    assert.equal(second.lock.runtime_sources.core.commit, second.release);
    assert.equal(second.lock.runtime_sources.smart.revision, second.release, "one release revision for both trees");
    assert.equal(second.lock.runtime_sources.smart.commit, first.release, "Smart is named by the commit that wrote it");
    assert.equal(second.lock.mirror.commit, first.lock.mirror.commit, "the mirror did not move either");
    // Asset paths follow the Smart writer; Core references follow the release.
    const entry = second.smart.entries[0];
    assert.deepEqual(entry.runtime.asset_paths, [`simai/ui@${first.release}:distr/smart/thing/js/thing.js`]);
    assert.ok(entry.provenance.source_refs.includes(`simai/ui@${second.release}:distr/rule/rule.json#name=cl-thing`));
    assert.equal(second.smart.release.commit, first.release);

    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: a mirror that is not byte-identical stops the binding", () => {
    const context = v2Fixture();
    publish(context, "core-1\n", "smart-1\n");
    writeFile(context.uiRoot, "distr/smart/thing/js/thing.js", "smart-2\n");
    commitAll(context.uiRoot, "Build");
    writeFile(context.mirrorRoot, "smart/thing/js/thing.js", "hand-edited\n");
    commitAll(context.mirrorRoot, "Build");
    const receipt = path.join(context.workspace, "drift.json");
    execFileSync("python3", [RECEIPT_TOOL, "--ui-root", context.uiRoot, "--mirror-root", context.mirrorRoot, "--source-root", context.sourceRoot, "--output", receipt]);
    assert.throws(
        () => execFileSync("python3", [TOOL, "--ui-root", context.uiRoot, "--smart-root", context.uiRoot, "--mirror-root", context.mirrorRoot, "--receipt", receipt, "--source-root", context.sourceRoot, "--phase", "owners"], { stdio: "pipe" }),
        (error) => /not byte-identical/.test(String(error.stderr)),
    );
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: a receipt naming a commit that did not write the tree stops the binding", () => {
    const context = v2Fixture();
    publish(context, "core-1\n", "smart-1\n");
    writeFile(context.uiRoot, "distr/core/core.css", "core-2\n");
    commitAll(context.uiRoot, "Build");
    const receipt = path.join(context.workspace, "wrong.json");
    execFileSync("python3", [RECEIPT_TOOL, "--ui-root", context.uiRoot, "--mirror-root", context.mirrorRoot, "--source-root", context.sourceRoot, "--output", receipt]);
    const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
    // Claim the release as Smart's writer although distr/smart did not move.
    const release = value.release_revision;
    const smartPath = "distr/smart";
    value.runtime_sources.smart = {
        ...value.runtime_sources.smart,
        revision: release,
        tree: git(context.uiRoot, "rev-parse", `${release}^{tree}`),
        candidate_archive: { sha256: crypto.createHash("sha256").update(execFileSync("git", ["-C", context.uiRoot, "archive", "--format=tar", release])).digest("hex") },
        runtime_archive: { sha256: crypto.createHash("sha256").update(execFileSync("git", ["-C", context.uiRoot, "archive", "--format=tar", release, smartPath])).digest("hex") },
    };
    fs.writeFileSync(receipt, JSON.stringify(value));
    assert.throws(
        () => execFileSync("python3", [TOOL, "--ui-root", context.uiRoot, "--smart-root", context.uiRoot, "--mirror-root", context.mirrorRoot, "--receipt", receipt, "--source-root", context.sourceRoot, "--phase", "owners"], { stdio: "pipe" }),
        (error) => /was last written by/.test(String(error.stderr)),
    );
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

// A component a package provides (distr/core/contracts/packages/<name>.package.json in ui;
// SIMAI Framework Pro is the first) leaves the free Smart owner manifests in the
// release that stops shipping its folder, and not before.
function withPaidComponent(context)
{
    // The ui-owned manifest is seeded from the mirror's on the first v2 release,
    // so the mirror is where the entry starts.
    for (const root of [context.mirrorRoot]) {
        const file = path.join(root, "contracts/owners/smart-component.manifest.json");
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        const paid = JSON.parse(JSON.stringify(manifest.entries[0]).replaceAll("thing", "paid"));
        manifest.entries.push(paid);
        manifest.inventory.expected = 2;
        fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
        writeFile(root, "smart/paid/js/paid.js", "paid\n");
        commitAll(root, "add paid");
    }
}

function publishWithout(context, paidPresent)
{
    writeFile(context.uiRoot, "distr/core/contracts/packages/pro.package.json", `${JSON.stringify({provides: [{id: "smart-component.paid", element: "sf-paid", rule_name: "cl-paid", folder: "paid", requires: []}]})}\n`);
    commitAll(context.uiRoot, "name the package");
    writeFile(context.uiRoot, "distr/core/core.css", "core-2\n");
    writeFile(context.uiRoot, "distr/rule/rule.json", `${JSON.stringify([THING_RULE], null, 2)}\n`);
    writeFile(context.uiRoot, "distr/smart/thing/js/thing.js", "smart-1\n");
    if (paidPresent) writeFile(context.uiRoot, "distr/smart/paid/js/paid.js", "paid\n");
    else fs.rmSync(path.join(context.mirrorRoot, "smart/paid"), { recursive: true, force: true });
    commitAll(context.uiRoot, "Build");
    writeFile(context.mirrorRoot, "smart/thing/js/thing.js", "smart-1\n");
    commitAll(context.mirrorRoot, "Build");
    const receipt = path.join(context.workspace, "receipt-paid.json");
    execFileSync("python3", [RECEIPT_TOOL, "--ui-root", context.uiRoot, "--mirror-root", context.mirrorRoot, "--source-root", context.sourceRoot, "--output", receipt]);
    return execFileSync("python3", [
        TOOL, "--ui-root", context.uiRoot, "--smart-root", context.uiRoot, "--mirror-root", context.mirrorRoot,
        "--receipt", receipt, "--source-root", context.sourceRoot, "--phase", "owners",
    ], { encoding: "utf8", stdio: "pipe" });
}

test("v2: a package component leaves both Smart owner manifests with its folder", () => {
    const context = v2Fixture();
    withPaidComponent(context);
    const said = publishWithout(context, false);
    assert.match(said, /Retired from the ui Smart owner manifest \(provided by a package\): smart-component\.paid/u);
    assert.match(said, /Retired from the mirror Smart owner manifest \(provided by a package\): smart-component\.paid/u);
    for (const root of [context.uiRoot, context.mirrorRoot]) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "contracts/owners/smart-component.manifest.json"), "utf8"));
        assert.deepEqual(manifest.entries.map(({id}) => id), ["smart-component.thing"]);
        assert.equal(manifest.inventory.expected, 1);
    }
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: a package component whose folder is still in the release stops the binding", () => {
    const context = v2Fixture();
    withPaidComponent(context);
    // The mirror keeps smart/paid: the free release would still ship it.
    assert.throws(() => publishWithout(context, true), (error) => /smart-component\.paid: a package provides it, but (distr\/)?smart\/paid is still in the release/u.test(String(error.stderr || error.message)));
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

// The Smart owner manifest follows what the release ships: a component the
// build adds gets an entry (ui-9fb0297bb5c2 added sf-page-header and the gate
// stopped on smart_rule_count_mismatch until one was written by hand), and a
// component the build drops loses its entry.
const NEW_RULE = { name: "cl-new-thing", type: "smart", mode: "smart", js: true, css: true, tags: ["sf-new-thing"], relation: [{ name: "cl-thing" }, { name: "buttons" }] };

function addNewThing(context)
{
    writeFile(context.sourceRoot, "src/smart/new-thing/smart.manifest.json", `${JSON.stringify({ id: "smart.new-thing", title: "New thing", lifecycle: "experimental" }, null, 2)}\n`);
    commitAll(context.sourceRoot, "describe new-thing");
    for (const file of ["js/new-thing.js", "js/new-thing.js.gz", "css/new-thing.css", "template/default/index.html", "template/default.js", "smart.manifest.json", "studio.fixture.json"]) {
        writeFile(context.uiRoot, `distr/smart/new-thing/${file}`, `${file}\n`);
    }
}

test("v2: a Smart component the release adds gets a discoverable entry", () => {
    const context = v2Fixture();
    const first = publish(context, "core-1\n", "smart-1\n");
    addNewThing(context);
    const second = publish(context, "core-2\n", "smart-1\n", [THING_RULE, NEW_RULE, { name: "buttons", type: "component" }]);
    const release = second.release;

    assert.deepEqual(second.smart.entries.map(({ id }) => id), ["smart-component.thing", "smart.new-thing"], "appended; the existing entry stays first");
    assert.equal(second.smart.inventory.expected, 2);
    assert.equal(second.lock.inventory.smart_components, 2, "the lock reads the recounted manifest");
    assert.deepEqual(second.smart.entries[0], JSON.parse(JSON.stringify(first.smart.entries[0]).replaceAll(first.release, release)), "the existing entry is only rebound");
    assert.deepEqual(second.smart.entries[1], {
        id: "smart.new-thing",
        kind: "smart-component",
        name: "new-thing",
        title: "New thing",
        owner: "simai/ui",
        lifecycle: "experimental",
        readiness: { status: "discoverable", safe_to_suggest: false, profiles: ["plain-assets-v1"], blockers: [] },
        provenance: {
            repository: "https://github.com/simai/ui",
            tag: null,
            commit: release,
            source_refs: [`simai/ui@${release}:distr/smart/new-thing`, `simai/ui@${release}:distr/rule/rule.json#name=cl-new-thing`],
        },
        documentation_refs: [`simai/ui@${release}:README.md`],
        example_refs: [],
        runtime: {
            rule_name: "cl-new-thing",
            tags: ["sf-new-thing"],
            // Below the component's subfolders, no .gz, ordered as the registry orders paths.
            asset_paths: ["css/new-thing.css", "js/new-thing.js", "template/default/index.html", "template/default.js"]
                .map((file) => `simai/ui@${release}:distr/smart/new-thing/${file}`),
            declared: { js: true, css: true },
        },
        requires: ["component.buttons", "smart.thing"],
        curated_for: [],
    });
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: the binder says what it added and removed", () => {
    const context = v2Fixture();
    publish(context, "core-1\n", "smart-1\n");
    addNewThing(context);
    const added = publish(context, "core-2\n", "smart-1\n", [THING_RULE, NEW_RULE, { name: "buttons", type: "component" }]);
    assert.match(added.said, /Added to the ui Smart owner manifest \(discoverable, not suggested; promote by hand\): smart\.new-thing/u);
    assert.doesNotMatch(added.said, /Removed from/u);
    fs.rmSync(path.join(context.uiRoot, "distr/smart/new-thing"), { recursive: true, force: true });
    const removed = publish(context, "core-3\n", "smart-2\n");
    assert.match(removed.said, /Removed from the ui Smart owner manifest \(no longer shipped\): smart\.new-thing/u);
    assert.doesNotMatch(removed.said, /Added to/u);
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: a Smart component the release drops loses its entry", () => {
    const context = v2Fixture();
    addNewThing(context);
    const first = publish(context, "core-1\n", "smart-1\n", [THING_RULE, NEW_RULE, { name: "buttons", type: "component" }]);
    assert.equal(first.smart.inventory.expected, 2);
    // The build drops new-thing: its folder and its rule are gone.
    fs.rmSync(path.join(context.uiRoot, "distr/smart/new-thing"), { recursive: true, force: true });
    const second = publish(context, "core-2\n", "smart-2\n");

    assert.deepEqual(second.smart.entries.map(({ id }) => id), ["smart-component.thing"]);
    assert.equal(second.smart.inventory.expected, 1);
    assert.equal(second.lock.inventory.smart_components, 1);
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: a component whose rule is gone loses its entry even if its folder stays", () => {
    const context = v2Fixture();
    const first = publish(context, "core-1\n", "smart-1\n");
    assert.equal(first.smart.entries.length, 1);
    addNewThing(context);
    const second = publish(context, "core-2\n", "smart-1\n", [NEW_RULE, { name: "buttons", type: "component" }]);
    assert.deepEqual(second.smart.entries.map(({ id }) => id), ["smart.new-thing"]);
    assert.equal(second.smart.inventory.expected, 1);
    fs.rmSync(context.workspace, { recursive: true, force: true });
});

test("v2: a shipped component the source does not describe stops the binding", () => {
    const context = v2Fixture();
    writeFile(context.uiRoot, "distr/smart/new-thing/js/new-thing.js", "js\n");
    assert.throws(
        () => publish(context, "core-1\n", "smart-1\n", [THING_RULE, NEW_RULE, { name: "buttons", type: "component" }]),
        (error) => /smart\.new-thing: distr\/smart\/new-thing and cl-new-thing ship, but the source has no src\/smart\/new-thing\/smart\.manifest\.json/u.test(String(error.stderr || error.message)),
    );
    fs.rmSync(context.workspace, { recursive: true, force: true });
});
