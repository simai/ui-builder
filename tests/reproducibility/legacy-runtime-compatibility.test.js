"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    compatibilityFromEnvironment,
    materializeLegacyRuntimeCompatibility,
    validateLegacyRuntimeCompatibility,
} = require("../../libs/legacyRuntimeCompatibility");

function digest(content)
{
    return crypto.createHash("sha256").update(content).digest("hex");
}

function fixture()
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-legacy-runtime-"));
    const root = path.join(workspace, "legacy");
    const outputRoot = path.join(workspace, "output");
    const relative = "component/highlight/js/1058.js";
    const source = path.join(root, relative);
    const content = Buffer.from("legacy chunk\n");
    fs.mkdirSync(path.dirname(source), {recursive: true});
    fs.writeFileSync(source, content);
    fs.mkdirSync(outputRoot);
    const manifest = path.join(workspace, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({
        batch: "RTL-3I-LEGACY-RUNTIME-LINEAGE",
        generated_repository: {revision: "ui-revision"},
        mode: "read_only_lineage_audit",
        records: [{path: relative, sha256: digest(content), size: content.length}],
        summary: {runtime_base_paths: 1, runtime_paths: 2},
    }));
    return {content, manifest, outputRoot, relative, root, workspace};
}

test("digest-bound legacy chunks materialize only for the matching product", () => {
    const subject = fixture();
    try
    {
        const contract = {
            manifest: subject.manifest,
            revision: "ui-revision",
            root: subject.root,
        };
        const written = materializeLegacyRuntimeCompatibility({
            entries: [{target: "component"}],
            legacyCompatibility: contract,
            outputRoot: subject.outputRoot,
        });
        assert.equal(written.length, 1);
        assert.deepEqual(
            fs.readFileSync(path.join(subject.outputRoot, subject.relative)),
            subject.content,
        );
        assert.equal(materializeLegacyRuntimeCompatibility({
            entries: [{target: "core"}],
            legacyCompatibility: contract,
            outputRoot: subject.outputRoot,
        }).length, 0);
    }
    finally
    {
        fs.rmSync(subject.workspace, {force: true, recursive: true});
    }
});

test("removed Component and Smart URL surfaces remain compatibility targets", () => {
    const subject = fixture();
    try
    {
        const smartRelative = "smart/editor/js/editor.js";
        const smartContent = Buffer.from("legacy smart bundle\n");
        const smartSource = path.join(subject.root, smartRelative);
        fs.mkdirSync(path.dirname(smartSource), {recursive: true});
        fs.writeFileSync(smartSource, smartContent);
        const manifest = JSON.parse(fs.readFileSync(subject.manifest, "utf8"));
        manifest.records.push({
            path: smartRelative,
            sha256: digest(smartContent),
            size: smartContent.length,
        });
        manifest.summary = {runtime_base_paths: 2, runtime_paths: 4};
        fs.writeFileSync(subject.manifest, JSON.stringify(manifest));

        const written = materializeLegacyRuntimeCompatibility({
            entries: [{target: "smart"}],
            legacyCompatibility: {
                manifest: subject.manifest,
                revision: "ui-revision",
                root: subject.root,
            },
            outputRoot: subject.outputRoot,
        });

        assert.equal(written.length, 1);
        assert.deepEqual(
            fs.readFileSync(path.join(subject.outputRoot, smartRelative)),
            smartContent,
        );
    }
    finally
    {
        fs.rmSync(subject.workspace, {force: true, recursive: true});
    }
});

test("manifest digest, revision, collision and partial environment fail closed", () => {
    const subject = fixture();
    try
    {
        assert.throws(() => validateLegacyRuntimeCompatibility({
            manifest: subject.manifest,
            revision: "wrong",
            root: subject.root,
        }), /revision mismatch/);
        const collision = path.join(subject.outputRoot, subject.relative);
        fs.mkdirSync(path.dirname(collision), {recursive: true});
        fs.writeFileSync(collision, "different chunk\n");
        assert.throws(() => materializeLegacyRuntimeCompatibility({
            entries: [{target: "component"}],
            legacyCompatibility: {
                manifest: subject.manifest,
                revision: "ui-revision",
                root: subject.root,
            },
            outputRoot: subject.outputRoot,
        }), /collision/);
        fs.appendFileSync(path.join(subject.root, subject.relative), "drift");
        assert.throws(() => validateLegacyRuntimeCompatibility({
            manifest: subject.manifest,
            revision: "ui-revision",
            root: subject.root,
        }), /digest mismatch/);
        assert.throws(() => compatibilityFromEnvironment({
            SF_LEGACY_COMPATIBILITY_ROOT: subject.root,
        }), /all SF_LEGACY_COMPATIBILITY/);
    }
    finally
    {
        fs.rmSync(subject.workspace, {force: true, recursive: true});
    }
});
