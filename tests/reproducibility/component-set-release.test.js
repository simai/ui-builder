"use strict";

// Component sets (standard simai.component-set 1.0.0, pair ranges since
// 1.2.0): the api rule in the generated rule file, the passport checks of the
// receipt, the generic release route (publish-package-release.sh,
// bind-package-release.py, the pair range of a release over a free pair) and
// the compatibility index (set-index.py).

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readPackageRuleFile, renderPackageRuleFile } = require("../../libs/packageProduct");

const SCRIPTS = path.resolve(__dirname, "../../scripts");
const RECEIPT = path.join(SCRIPTS, "write-package-receipt.py");
const BIND = path.join(SCRIPTS, "bind-package-release.py");
const PUBLISH = path.join(SCRIPTS, "publish-package-release.sh");
const INDEX = path.join(SCRIPTS, "set-index.py");
const ASSETS = path.join(SCRIPTS, "package-release-assets.py");
const UPLOAD = path.join(SCRIPTS, "upload-package-release.sh");
const SOURCE_REVISION = "a".repeat(40);
const RULES = {
    "cl-glow": { css: true, js: true, mode: "smart", tags: ["sf-glow"], type: "smart" },
};

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function writeFile(root, relativePath, content)
{
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
}

function git(root, ...args)
{
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function commit(root, files, message = "fixture")
{
    for (const [relativePath, content] of Object.entries(files)) writeFile(root, relativePath, content);
    git(root, "add", "-A");
    git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message);
    return git(root, "rev-parse", "HEAD");
}

function filesUnder(root, current = root)
{
    return fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .flatMap((entry) =>
        {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) return filesUnder(root, full);
            const data = fs.readFileSync(full);
            return [{ path: path.relative(root, full).split(path.sep).join("/"), sha256: sha256(data), size: data.length }];
        });
}

function run(command, args, options = {})
{
    return spawnSync(command, args, { encoding: "utf8", ...options });
}

const passport = (extra = {}) => ({
    schema: "simai.framework.component-set",
    schema_version: 1,
    standard: { id: "simai.component-set", version: "1.0.0" },
    id: "fx",
    title: "Fixture set",
    summary: "A set for the tests.",
    repository: "example/ui-fx",
    licence: { class: "framework", spdx: "Apache-2.0" },
    framework: { core_runtime: ">=1.25.0", source_revision: SOURCE_REVISION },
    requires_sets: [],
    families: ["glow"],
    docs: "https://fx.example.org/",
    components: [{ element: "sf-glow", rule: "cl-glow", folder: "glow", status: "preview", requires: [] }],
    ...extra,
});

/** A set repository on a release branch, and the workspace a build of it leaves. */
function setRelease({ passportValue = passport(), api = "cl-glow", rules = RULES } = {})
{
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "set-repo-"));
    git(repo, "init", "-q", "-b", "main");
    const revision = commit(repo, {
        "package/package.json": `${JSON.stringify({ name: "@simai-studio/fx", version: "1.0.0", license: "Apache-2.0", simai: { set: "fx", api } })}\n`,
        "package/set.json": `${JSON.stringify(passportValue)}\n`,
        "package/framework.lock.json": "{}\n",
    }, "source");
    git(repo, "switch", "-q", "-c", "release/fx");

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "set-workspace-"));
    const output = path.join(workspace, "wave-1/output/package/fx");
    const passportBytes = `${JSON.stringify(passportValue)}\n`;
    writeFile(output, "set.json", passportBytes);
    writeFile(output, "smart/glow/js/glow.js", "/* glow */\n");
    writeFile(output, "smart/glow/css/glow.css", "sf-glow{display:block}\n");
    writeFile(output, "smart/rule.js", renderPackageRuleFile("fx", rules, undefined, { api }));
    const files = filesUnder(output);
    writeFile(workspace, "report.json", `${JSON.stringify({
        builder: { clean: true, revision: "b".repeat(40), root: "/builder" },
        components: ["glow"],
        node: "v20.19.5",
        output: "wave-1/output/package/fx",
        package: "fx",
        package_source: { path: "package", repository: "example/ui-fx", revision, root: repo },
        product: "package",
        products: { package: { byte_identical: true, files_count: files.length, manifest_sha256: sha256(`${JSON.stringify(files)}\n`) } },
        schema_version: 1,
        set: { passport: passportValue, sha256: sha256(passportBytes), api },
        source_revision: SOURCE_REVISION,
        status: "PASS",
    }, null, 2)}\n`);
    return { output, repo, revision, workspace };
}

test("a set's rule file names its api rule, and every reader takes it back", () => {
    const rendered = renderPackageRuleFile("fx", RULES, undefined, { api: "cl-glow" });
    assert.match(rendered, /registerPackage\("fx", \{\n {2}api: "cl-glow",\n {2}rules: /u);
    assert.deepEqual(readPackageRuleFile(rendered), { packageName: "fx", rules: RULES, api: "cl-glow" });
    assert.equal(renderPackageRuleFile("fx", RULES), renderPackageRuleFile("fx", RULES, undefined, {}), "no api: the form before sets");
    assert.throws(() => renderPackageRuleFile("fx", RULES, undefined, { api: "cl-other" }), /api cl-other is not one of its rules/u);

    const registered = [];
    new Function("SF", rendered)({ RuleLoader: { registerPackage: (name, value) => registered.push([name, value]) } });
    assert.equal(registered[0][1].api, "cl-glow");

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "set-rule-")), "rule.js");
    fs.writeFileSync(file, rendered);
    const read = run("python3", ["-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bind', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(json.dumps(module.read_rule_file(sys.argv[2], 'fx')))`, BIND, file]);
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), ["fx", "cl-glow", RULES]);
});

test("the receipt of a set carries a set block and refuses a passport that disagrees with the build", () => {
    const good = setRelease();
    const result = run("python3", [RECEIPT, "--report", path.join(good.workspace, "report.json")]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(good.workspace, "package-receipt.json"), "utf8"));
    assert.equal(receipt.set.id, "fx");
    assert.equal(receipt.set.api, "cl-glow");
    assert.deepEqual(receipt.set.families, ["glow"]);
    assert.ok(receipt.files.some((item) => item.path === "set.json"));

    const wrong = setRelease({ passportValue: passport({ families: ["other"], licence: { class: "framework", spdx: "MIT" } }) });
    const refused = run("python3", [RECEIPT, "--report", path.join(wrong.workspace, "report.json")]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /licence MIT, package.json says Apache-2.0/u);
    assert.match(refused.stderr, /sf-glow: family not in \['other'\]/u);

    const registry = path.join(good.workspace, "names.json");
    fs.writeFileSync(registry, JSON.stringify({ owners: [{ id: "fx", repository: "example/ui-fx", families: ["glow", "spark"] }] }));
    const disagreeing = run("python3", [RECEIPT, "--report", path.join(good.workspace, "report.json"), "--registry", registry]);
    assert.notEqual(disagreeing.status, 0);
    assert.match(disagreeing.stderr, /the registry gives \['glow', 'spark'\]/u);
});

/** A ui checkout with one free release built from SOURCE_REVISION. */
function freeRelease()
{
    const ui = fs.mkdtempSync(path.join(os.tmpdir(), "set-ui-"));
    git(ui, "init", "-q", "-b", "main");
    const build = commit(ui, {
        "distr/rule/rule.json": `${JSON.stringify([{ name: "cl-buttons", type: "smart", tags: ["sf-button"] }])}\n`,
    }, "build");
    const id = `ui-${build.slice(0, 12)}`;
    commit(ui, {
        [`contracts/releases/${id}.lock.json`]: `${JSON.stringify({
            schema_version: 2,
            compatibility_id: id,
            runtime_sources: { core: { revision: build } },
            build_inputs: { source: { commit: SOURCE_REVISION } },
        })}\n`,
    }, "bind");
    return { id, ui };
}

test("a set's relation to a rule of a set its passport requires is met by the registry's names for that set", () => {
    const { ui } = freeRelease();
    const rules = { "cl-glow": { ...RULES["cl-glow"], relation: [{ name: "cl-buttons" }, { name: "cl-view-properties", lazy: true }] } };
    const component = { ...passport().components[0], requires: ["cl-buttons", "cl-view-properties"] };
    const registryOwners = [
        { id: "fx", kind: "set", repository: "example/ui-fx", families: ["glow"], names: [{ element: "sf-glow", status: "released" }] },
        { id: "view", kind: "set", repository: "simai/ui-view", families: ["view"], names: [{ element: "sf-view-properties", status: "released" }] },
        { id: "mail", kind: "set", repository: "simai/ui-mail", families: ["mail"], names: [{ element: "sf-mail-canvas", status: "released" }] },
    ];
    const receiptOf = (passportValue, relations, withRegistry = true) => {
        const release = setRelease({ passportValue: { ...passportValue, components: [component] }, rules: { "cl-glow": { ...rules["cl-glow"], relation: relations } } });
        const registry = path.join(release.workspace, "names.json");
        fs.writeFileSync(registry, JSON.stringify({ owners: registryOwners }));
        return run("python3", [RECEIPT, "--report", path.join(release.workspace, "report.json"), "--ui", ui, ...(withRegistry ? ["--registry", registry] : [])]);
    };
    const requiresView = passport({ requires_sets: [{ id: "view", range: ">=1.3.0 <2.0.0" }] });

    const met = receiptOf(requiresView, rules["cl-glow"].relation);
    assert.equal(met.status, 0, met.stderr);

    // Not required: the same relation is refused.
    const notRequired = receiptOf(passport(), rules["cl-glow"].relation);
    assert.notEqual(notRequired.status, 0);
    assert.match(notRequired.stderr, /cl-glow: relation cl-view-properties is neither a package rule nor a rule of ui-[0-9a-f]{12} nor of a set the passport requires/u);

    // Required, but the rule is another set's: refused.
    const otherSet = receiptOf(requiresView, [{ name: "cl-buttons" }, { name: "cl-mail-canvas" }]);
    assert.notEqual(otherSet.status, 0);
    assert.match(otherSet.stderr, /relation cl-mail-canvas is neither/u);

    // No registry: the required set's names are unknown, so the relation is refused.
    const noRegistry = receiptOf(requiresView, rules["cl-glow"].relation, false);
    assert.notEqual(noRegistry.status, 0);
    assert.match(noRegistry.stderr, /relation cl-view-properties is neither/u);
});

test("the generic route lays the build, binds the lock, passes its gate and never touches main", () => {
    const { repo, revision, workspace } = setRelease();
    const work = path.join(workspace, "release");
    const published = run("bash", [PUBLISH, "--report", path.join(workspace, "report.json"), "--repo", repo,
        "--version", "1.0.0", "--subject", "first release", "--out", "dist", "--work", work, "--trailer", "Trailer: test"], {
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@example.invalid" },
    });
    assert.equal(published.status, 0, published.stderr + published.stdout);
    const id = `fx-${revision.slice(0, 12)}`;
    assert.match(published.stdout, new RegExp(`RELEASE ${id} version=1\\.0\\.0`, "u"));
    assert.match(published.stdout, /Nothing was pushed\./u);

    assert.deepEqual(git(repo, "log", "--format=%s", "-3").split("\n"), [`Bind the fx release ${id}`, "Build: fx first release", "source"]);
    assert.match(git(repo, "log", "-1", "--format=%B"), /Trailer: test/u);
    assert.equal(git(repo, "rev-parse", "main"), revision, "main did not move");
    assert.deepEqual(git(repo, "ls-tree", "-r", "--name-only", "HEAD", "package/dist").split("\n").sort(), [
        "package/dist/package-receipt.json", "package/dist/set.json", "package/dist/smart/glow/css/glow.css",
        "package/dist/smart/glow/js/glow.js", "package/dist/smart/rule.js",
    ]);

    const lock = JSON.parse(fs.readFileSync(path.join(repo, `contracts/releases/${id}.lock.json`), "utf8"));
    assert.equal(lock.schema, "simai.framework.package-release-lock");
    assert.equal(lock.version, "1.0.0");
    assert.equal(lock.build.path, "package/dist");
    assert.equal(lock.build.revision, git(repo, "rev-parse", "HEAD~1"));
    assert.equal(lock.requires.core_runtime, ">=1.25.0");
    assert.equal(lock.requires.framework, null);

    const stamped = JSON.parse(fs.readFileSync(path.join(work, "set.json"), "utf8"));
    assert.deepEqual(stamped.release, { id, version: "1.0.0", source_revision: revision });
    assert.equal(fs.readFileSync(path.join(repo, "package/dist/set.json"), "utf8"), `${JSON.stringify(passport())}\n`, "the repository keeps the built bytes");

    const gate = run("python3", [BIND, "check", "--repo", repo]);
    assert.equal(gate.status, 0, gate.stderr);

    // The release assets: the archive under the release's name and under the
    // set's name alone, the same bytes, the receipt's and the lock's archive.
    const assets = path.join(work, "assets");
    assert.match(published.stdout, new RegExp(`ASSETS ${assets.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.deepEqual(fs.readdirSync(assets).sort(), [
        `package-${id}.tar`, "package-fx.tar", "package-fx.tar.sha256", "package-receipt.json", `set-${id}.json`,
    ]);
    const archive = sha256(fs.readFileSync(path.join(assets, "package-fx.tar")));
    assert.equal(sha256(fs.readFileSync(path.join(assets, `package-${id}.tar`))), archive, "the two archives are the same bytes");
    assert.equal(fs.readFileSync(path.join(assets, "package-fx.tar.sha256"), "utf8"), `${archive}  package-fx.tar\n`);
    assert.equal(lock.output.archive_sha256, archive);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(assets, `set-${id}.json`), "utf8")), stamped);
    const lockPath = path.join(repo, `contracts/releases/${id}.lock.json`);
    const checked = run("python3", [ASSETS, "check", "--dir", assets, "--release", id, "--lock", lockPath]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, new RegExp(`ASSETS ${id} archive_sha256=${archive}`, "u"));
    const dry = run("bash", [UPLOAD, "--assets", assets, "--release", id, "--github", "example/ui-fx", "--lock", lockPath, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`would run: gh release create ${id} -R example/ui-fx --title fx\\\\ 1\\.0\\.0\\\\ \\\\\\(${id}\\\\\\)`, "u"));
    for (const name of [`package-${id}.tar`, "package-fx.tar", "package-fx.tar.sha256", "package-receipt.json", `set-${id}.json`]) {
        assert.ok(dry.stdout.includes(path.join(assets, name)), `the release carries ${name}`);
    }

    // A byte changed in the release output after the bind reds the gate.
    fs.writeFileSync(path.join(repo, "package/dist/smart/rule.js"), "// changed\n");
    commit(repo, {}, "tamper");
    const red = run("python3", [BIND, "check", "--repo", repo]);
    assert.notEqual(red.status, 0);
    assert.match(red.stderr, /package\/dist at HEAD is not the build of fx-/u);
});

test("the release assets refuse two archives that are not the same bytes", () => {
    const { repo, revision, workspace } = setRelease();
    const work = path.join(workspace, "release");
    const published = run("bash", [PUBLISH, "--report", path.join(workspace, "report.json"), "--repo", repo,
        "--version", "1.0.0", "--subject", "s", "--work", work], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
    });
    assert.equal(published.status, 0, published.stderr);
    const id = `fx-${revision.slice(0, 12)}`;
    const assets = path.join(work, "assets");
    const check = () => run("python3", [ASSETS, "check", "--dir", assets, "--release", id]);
    assert.equal(check().status, 0);

    const versioned = path.join(assets, `package-${id}.tar`);
    const original = fs.readFileSync(versioned);
    fs.appendFileSync(versioned, "x");
    assert.match(check().stderr, /package-fx\.tar \([0-9a-f]{64}\) and package-fx-[0-9a-f]{12}\.tar \([0-9a-f]{64}\) are not the same bytes/u);
    const upload = run("bash", [UPLOAD, "--assets", assets, "--release", id, "--github", "example/ui-fx", "--dry-run"]);
    assert.notEqual(upload.status, 0, "nothing is sent over assets that disagree");
    assert.match(upload.stderr, /UPLOAD_FAILED/u);
    fs.writeFileSync(versioned, original);

    fs.rmSync(path.join(assets, "package-fx.tar"));
    assert.match(check().stderr, /missing assets package-fx\.tar\b/u);
    fs.writeFileSync(path.join(assets, "package-fx.tar"), original);
    fs.writeFileSync(path.join(assets, "package-fx.tar.sha256"), `${"0".repeat(64)}  package-fx.tar\n`);
    assert.match(check().stderr, /package-fx\.tar\.sha256 reads/u);
});

test("the route refuses main and a dirty checkout", () => {
    const { repo, workspace } = setRelease();
    const args = ["--report", path.join(workspace, "report.json"), "--repo", repo, "--version", "1.0.0", "--subject", "s"];
    git(repo, "switch", "-q", "main");
    assert.match(run("bash", [PUBLISH, ...args]).stderr, /is on main/u);
    git(repo, "switch", "-q", "release/fx");
    fs.writeFileSync(path.join(repo, "stray.txt"), "x");
    assert.match(run("bash", [PUBLISH, ...args]).stderr, /is not clean/u);
});

test("the compatibility index takes a row from a bound release, once, and only over a free pair", () => {
    const { repo, revision, workspace } = setRelease();
    const work = path.join(workspace, "release");
    const published = run("bash", [PUBLISH, "--report", path.join(workspace, "report.json"), "--repo", repo,
        "--version", "1.0.0", "--subject", "s", "--work", work], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
    });
    assert.equal(published.status, 0, published.stderr);
    const id = `fx-${revision.slice(0, 12)}`;
    const lockPath = path.join(repo, `contracts/releases/${id}.lock.json`);
    const index = path.join(workspace, "sets/index.json");
    const add = (passportPath) => run("python3", [INDEX, "add", "--index", index, "--passport", passportPath, "--lock", lockPath, "--published-on", "2026-11-03"]);

    // Built over no free pair: refused.
    const unpaired = add(path.join(work, "set.json"));
    assert.notEqual(unpaired.status, 0);
    assert.match(unpaired.stderr, /built over no free pair/u);

    const paired = path.join(work, "set-paired.json");
    const stamped = JSON.parse(fs.readFileSync(path.join(work, "set.json"), "utf8"));
    stamped.framework.pair = "ui-0123456789ab";
    fs.writeFileSync(paired, JSON.stringify(stamped));
    const added = add(paired);
    assert.equal(added.status, 0, added.stderr);
    const value = JSON.parse(fs.readFileSync(index, "utf8"));
    assert.equal(value.schema, "simai.framework.set-index");
    assert.deepEqual(value.sets.map((entry) => [entry.id, entry.npm]), [["fx", "@simai-studio/fx"]]);
    assert.deepEqual(value.releases[0].framework, { core_runtime: ">=1.25.0", source_revision: SOURCE_REVISION, pair: "ui-0123456789ab" });
    assert.equal(value.releases[0].release, id);

    assert.match(add(paired).stderr, /already indexed/u);
    assert.equal(run("python3", [INDEX, "check", "--index", index]).status, 0);

    value.releases.push({ ...value.releases[0], version: "0.9.0" });
    fs.writeFileSync(index, JSON.stringify(value));
    assert.match(run("python3", [INDEX, "check", "--index", index]).stderr, /not in order/u);
});

/** A ui checkout holding one free pair built from SOURCE_REVISION. */
function freePair()
{
    const ui = fs.mkdtempSync(path.join(os.tmpdir(), "set-ui-"));
    git(ui, "init", "-q", "-b", "main");
    const build = commit(ui, {
        "distr/rule/rule.json": `${JSON.stringify([{ name: "cl-buttons", type: "smart", tags: ["sf-button"] }])}\n`,
        "distr/core/passports/core.runtime.json": `${JSON.stringify({ schema: "simai.framework.unit-passport", id: "core.runtime", version: "1.42.0" })}\n`,
        "distr/core/css/core.css": ":root{--sf-space-1:4px}\n",
    }, "build");
    const pair = `ui-${build.slice(0, 12)}`;
    commit(ui, {
        [`contracts/releases/${pair}.lock.json`]: `${JSON.stringify({
            schema_version: 2, compatibility_id: pair,
            runtime_sources: { core: { revision: build } }, build_inputs: { source: { commit: SOURCE_REVISION } },
        })}\n`,
    }, "bind");
    return { ui, pair };
}

test("over a free pair the route writes the pair range into the bind, the assets and the index row", () => {
    const { ui, pair } = freePair();
    const { repo, revision, workspace } = setRelease();
    const work = path.join(workspace, "release");
    const index = path.join(workspace, "sets/index.json");
    const published = run("bash", [PUBLISH, "--report", path.join(workspace, "report.json"), "--repo", repo, "--ui", ui,
        "--version", "1.0.0", "--subject", "over a pair", "--work", work, "--index", index], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
    });
    assert.equal(published.status, 0, published.stderr + published.stdout);
    const id = `fx-${revision.slice(0, 12)}`;
    const lockPath = path.join(repo, `contracts/releases/${id}.lock.json`);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lock.requires.framework, pair);

    // One bind commit holds the lock and the range.
    assert.deepEqual(git(repo, "log", "--format=%s", "-2").split("\n"), [`Bind the fx release ${id}`, "Build: fx over a pair"]);
    assert.deepEqual(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort(),
        [`contracts/pair-ranges/${id}.json`, `contracts/releases/${id}.lock.json`]);
    const bytes = fs.readFileSync(path.join(repo, `contracts/pair-ranges/${id}.json`));
    const range = JSON.parse(bytes);
    assert.equal(range.schema, "simai.framework.set-pair-range");
    assert.equal(range.release, id);
    assert.equal(range.built_over.pair, pair);
    assert.equal(range.package.archive_sha256, lock.output.archive_sha256);
    assert.deepEqual(range.requires.free_elements, []);
    assert.equal(range.requires.core_runtime, ">=1.25.0");
    assert.equal(run("python3", [BIND, "check", "--repo", repo, "--ui-root", ui]).status, 0, "the release gate stays green");

    // The same bytes are a release asset, checked with the others.
    const assets = path.join(work, "assets");
    assert.ok(fs.readdirSync(assets).includes("pair-range.json"));
    assert.ok(fs.readFileSync(path.join(assets, "pair-range.json")).equals(bytes));
    assert.equal(run("python3", [ASSETS, "check", "--dir", assets, "--release", id, "--lock", lockPath]).status, 0);
    const dry = run("bash", [UPLOAD, "--assets", assets, "--release", id, "--github", "example/ui-fx", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(dry.stdout.includes(path.join(assets, "pair-range.json")), "the release carries pair-range.json");

    // A range of another release is refused among the assets.
    const other = { ...range, release: "fx-000000000000" };
    fs.writeFileSync(path.join(assets, "pair-range.json"), JSON.stringify(other));
    assert.match(run("python3", [ASSETS, "check", "--dir", assets, "--release", id]).stderr, /pair-range\.json is the range of 'fx-000000000000'/u);
    fs.writeFileSync(path.join(assets, "pair-range.json"), bytes);

    // The index row names the range by its bytes and its interface.
    const row = JSON.parse(fs.readFileSync(index, "utf8")).releases.find((item) => item.release === id);
    assert.deepEqual(row.range, { sha256: sha256(bytes), interface_sha256: range.interface_sha256 });
    assert.equal(run("python3", [INDEX, "check", "--index", index]).status, 0);
});

test("set-index range names a range once, only the range of that row, and check reads it", () => {
    const { ui } = freePair();
    const { repo, revision, workspace } = setRelease();
    const work = path.join(workspace, "release");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const published = run("bash", [PUBLISH, "--report", path.join(workspace, "report.json"), "--repo", repo, "--ui", ui,
        "--version", "1.0.0", "--subject", "s", "--work", work], { env });
    assert.equal(published.status, 0, published.stderr + published.stdout);
    const id = `fx-${revision.slice(0, 12)}`;
    const index = path.join(workspace, "sets/index.json");
    const rangePath = path.join(work, "pair-range.json");
    const range = JSON.parse(fs.readFileSync(rangePath, "utf8"));
    const name = (file) => run("python3", [INDEX, "range", "--index", index, "--range", file]);

    assert.match(name(rangePath).stderr, new RegExp(`${id} is not indexed`, "u"), "the row comes first");
    assert.equal(run("python3", [INDEX, "add", "--index", index, "--passport", path.join(work, "set.json"),
        "--lock", path.join(repo, `contracts/releases/${id}.lock.json`), "--published-on", "2026-11-09"]).status, 0);

    const edited = path.join(work, "edited.json");
    fs.writeFileSync(edited, JSON.stringify({ ...range, requires: { ...range.requires, core_runtime: ">=0.0.1" } }));
    assert.match(name(edited).stderr, /interface_sha256 is not the digest of its requires/u);
    const otherArchive = path.join(work, "other.json");
    fs.writeFileSync(otherArchive, JSON.stringify({ ...range, package: { ...range.package, archive_sha256: "7".repeat(64) } }));
    assert.match(name(otherArchive).stderr, /package\.archive_sha256 7{64}, the row of/u);

    const first = name(rangePath);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(name(rangePath).status, 0, "the same range again changes nothing");
    const reformatted = path.join(work, "reformatted.json");
    fs.writeFileSync(reformatted, JSON.stringify(range));
    assert.match(name(reformatted).stderr, /already names another range/u, "other bytes are another range");

    const value = JSON.parse(fs.readFileSync(index, "utf8"));
    assert.equal(run("python3", [INDEX, "check", "--index", index]).status, 0);
    value.releases[0].range = { sha256: "x" };
    fs.writeFileSync(index, JSON.stringify(value));
    assert.match(run("python3", [INDEX, "check", "--index", index]).stderr, /range is not \{sha256, interface_sha256\}/u);
});

test("a release built over no free pair binds its lock alone, with no pair range", () => {
    const { repo, workspace } = setRelease();
    // Without --ui the receipt names no pair, so there is nothing to range: the
    // route says so and binds the lock alone.
    const published = run("bash", [PUBLISH, "--report", path.join(workspace, "report.json"), "--repo", repo,
        "--version", "1.0.0", "--subject", "s", "--work", path.join(workspace, "release")], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
    });
    assert.equal(published.status, 0, published.stderr);
    assert.match(published.stdout, /no free pair: fx-[0-9a-f]{12} carries no pair range/u);
    assert.equal(fs.existsSync(path.join(repo, "contracts/pair-ranges")), false);
});
