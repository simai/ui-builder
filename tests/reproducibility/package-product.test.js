"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    collectPackageRules,
    materializePackageOverlay,
    readPackageRuleFile,
    renderPackageRuleFile,
    resolvePackageSource,
} = require("../../libs/packageProduct");
const { runPackageBuild } = require("../../libs/componentBuildLifecycle");

const RECEIPT_SCRIPT = path.resolve(__dirname, "../../scripts/write-package-receipt.py");

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

function repository(files)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-product-"));
    git(root, "init", "-q");
    commit(root, files);
    return root;
}

function rule(name, extra = "", relations = '[{name: "icons"}]')
{
    return `SF.RuleLoader["cl-${name}"] = {tags: ["sf-${name}"], type: "smart", mode: "smart", js: true, ${extra}relation: ${relations}};\n`;
}

function lock(sourceRevision, extra = {})
{
    return `${JSON.stringify({
        schema: "simai.framework.product-package-source-lock.v1",
        source: { repository: "simai/ui-source", revision: sourceRevision },
        ...extra,
    })}\n`;
}

test("the package rule file registers the package's rules under its name, as sorted plain data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-rules-"));
    writeFile(root, "smart/widget/rule.js", rule("widget", "css: true, "));
    writeFile(root, "smart/gauge/rule.js", rule("gauge"));
    const rules = collectPackageRules(root, ["widget", "gauge"]);
    assert.deepEqual(Object.keys(rules), ["cl-gauge", "cl-widget"]);
    assert.deepEqual(Object.keys(rules["cl-widget"]), ["css", "js", "mode", "relation", "tags", "type"]);

    const rendered = renderPackageRuleFile("acme", rules);
    assert.match(rendered, /^\/\/ Package acme: the package rule file\./u);
    assert.match(rendered, /SF_BOOT_CONFIG\.packages\.acme\./u);
    assert.match(rendered, /\nSF\.RuleLoader\.registerPackage\("acme", \{\n {2}rules: \{/u);
    assert.equal(rendered, renderPackageRuleFile("acme", collectPackageRules(root, ["gauge", "widget"])), "rendering is deterministic");
    assert.deepEqual(readPackageRuleFile(rendered), { packageName: "acme", rules: JSON.parse(JSON.stringify(rules)) });

    const registered = [];
    new Function("SF", rendered)({ RuleLoader: { registerPackage: (name, value) => registered.push([name, value]) } });
    assert.deepEqual(JSON.parse(JSON.stringify(registered)), [["acme", { rules: JSON.parse(JSON.stringify(rules)) }]]);

    assert.throws(() => renderPackageRuleFile("Acme", rules), /package name must match/u);
    assert.throws(() => renderPackageRuleFile("1st", rules), /package name must match/u);
});

test("a package rule.js must write exactly its own rule, as data, and claim its own element", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-rules-"));
    writeFile(root, "smart/widget/rule.js", rule("widget") + rule("extra"));
    assert.throws(() => collectPackageRules(root, ["widget"]), /must write exactly cl-widget, wrote cl-widget, cl-extra/u);
    writeFile(root, "smart/widget/rule.js", rule("widget", 'package: "acme", '));
    assert.throws(() => collectPackageRules(root, ["widget"]), /without a package field/u);
    writeFile(root, "smart/widget/rule.js", rule("widget", "regex: /x/, "));
    assert.throws(() => collectPackageRules(root, ["widget"]), /not plain data/u);
    writeFile(root, "smart/widget/rule.js", "SF.RuleLoader['cl-widget'] = eval('({})');\n");
    assert.throws(() => collectPackageRules(root, ["widget"]), /Code generation from strings disallowed/u);
    writeFile(root, "smart/widget/rule.js", rule("widget"));
    writeFile(root, "smart/gauge/rule.js", 'SF.RuleLoader["cl-gauge"] = {tags: ["sf-widget"], type: "smart"};\n');
    assert.throws(() => collectPackageRules(root, ["widget", "gauge"]), /both claim <sf-widget>/u);
    assert.throws(() => collectPackageRules(root, ["missing"]), /smart\/missing has no rule\.js/u);
});

test("the overlay takes a package from a subdirectory of a larger repository, at a commit", () => {
    const uiSource = repository({
        "package.json": "{}\n",
        "src/smart/helpers/dom.js": "export const dom = 1;\n",
        "src/smart/buttons/index.js": "export default 1;\n",
    });
    const pin = git(uiSource, "rev-parse", "HEAD");
    const product = repository({
        "README.md": "the product\n",
        "app/server.php": "<?php\n",
        "resources/ui/framework.lock.json": lock(pin, { package: "acme" }),
        "resources/ui/src/smart/widget/index.js": 'import "../helpers/dom";\n',
        "resources/ui/src/smart/widget/rule.js": rule("widget"),
        "resources/ui/src/smart/gauge/index.js": "export default 2;\n",
        "resources/ui/src/smart/gauge/rule.js": rule("gauge"),
        "resources/ui/tests/widget.test.mjs": "\n",
        "resources/ui/src/smart/acme-helpers/format.js": "export const format = 1;\n",
        "resources/ui/notes.md": "not laid\n",
    });
    const built = git(product, "rev-parse", "HEAD");
    writeFile(product, "resources/ui/src/smart/widget/index.js", "a working-tree edit that must not leak\n");

    const fromInside = resolvePackageSource({ packageRoot: path.join(product, "resources/ui") });
    assert.equal(fromInside.packagePath, "resources/ui");
    assert.equal(fs.realpathSync(fromInside.repositoryRoot), fs.realpathSync(product));
    assert.deepEqual(resolvePackageSource({ repositoryRoot: product, packagePath: "resources/ui/" }).packagePath, "resources/ui");
    assert.throws(() => resolvePackageSource({ repositoryRoot: product, packagePath: "../elsewhere" }), /inside the repository/u);

    const overlayRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "package-overlay-")), "overlay");
    const result = materializePackageOverlay({
        overlayRoot,
        packageName: "acme",
        packagePath: "resources/ui",
        repositoryRoot: product,
        uiSourceRoot: uiSource,
    });
    assert.deepEqual(result, {
        components: ["gauge", "widget"],
        laid_files: 6,
        package_path: "resources/ui",
        package_revision: built,
        source_revision: pin,
    });
    assert.equal(fs.readFileSync(path.join(overlayRoot, "src/smart/widget/index.js"), "utf8"), 'import "../helpers/dom";\n');
    assert.ok(fs.existsSync(path.join(overlayRoot, "src/smart/buttons/index.js")));
    assert.ok(fs.existsSync(path.join(overlayRoot, "tests/widget.test.mjs")));
    assert.ok(fs.existsSync(path.join(overlayRoot, "src/smart/acme-helpers/format.js")), "a folder without rule.js is laid, not built");
    assert.ok(!fs.existsSync(path.join(overlayRoot, "notes.md")), "only src, tests and docs are laid");
    assert.ok(!fs.existsSync(path.join(overlayRoot, "app")), "nothing outside the package path is laid");

    const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "package-overlay-")), "overlay");
    assert.throws(() => materializePackageOverlay({
        overlayRoot: other, packageName: "other", packagePath: "resources/ui", repositoryRoot: product, uiSourceRoot: uiSource,
    }), /declares package acme, built as other/u);
    assert.throws(() => materializePackageOverlay({
        components: ["widget"], overlayRoot: other, packageName: "acme", packagePath: "resources/ui", repositoryRoot: product, uiSourceRoot: uiSource,
    }), /holds src\/smart\/gauge, not one of widget/u);
});

test("a package may not shadow ui-source, and must pin a full revision the checkout holds", () => {
    const uiSource = repository({ "package.json": "{}\n", "src/smart/helpers/dom.js": "export const dom = 1;\n" });
    const pin = git(uiSource, "rev-parse", "HEAD");
    const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "package-overlay-")), "overlay");
    const shadow = repository({
        "framework.lock.json": lock(pin),
        "src/smart/widget/rule.js": rule("widget"),
        "src/smart/helpers/dom.js": "a shadow\n",
    });
    assert.throws(
        () => materializePackageOverlay({ overlayRoot: fresh(), packageName: "acme", repositoryRoot: shadow, uiSourceRoot: uiSource }),
        /would replace ui-source's src\/smart\/helpers\/dom\.js/u,
    );
    const unknown = repository({ "framework.lock.json": lock("0".repeat(40)), "src/smart/widget/rule.js": rule("widget") });
    assert.throws(() => materializePackageOverlay({ overlayRoot: fresh(), packageName: "acme", repositoryRoot: unknown, uiSourceRoot: uiSource }), /cat-file/u);
    const short = repository({ "framework.lock.json": lock("abc123"), "src/smart/widget/rule.js": rule("widget") });
    assert.throws(() => materializePackageOverlay({ overlayRoot: fresh(), packageName: "acme", repositoryRoot: short, uiSourceRoot: uiSource }), /full commit/u);
    const unlocked = repository({ "src/smart/widget/rule.js": rule("widget") });
    assert.throws(() => materializePackageOverlay({ overlayRoot: fresh(), packageName: "acme", repositoryRoot: unlocked, uiSourceRoot: uiSource }), /framework\.lock\.json is missing/u);
});

test("the package lifecycle refuses a malformed package definition before planning", async () => {
    const diagnostics = [];
    const runtime = { adapters: {}, reportDiagnostic: value => diagnostics.push(value), webpack() { throw new Error("not reached"); } };
    const base = { outputRoot: "/tmp/never", sourceRoot: "/tmp/never" };
    assert.equal(await runPackageBuild({ ...base }, runtime), 2);
    assert.equal(await runPackageBuild({ ...base, package: { name: "Acme", components: ["widget"] } }, runtime), 2);
    assert.equal(await runPackageBuild({ ...base, package: { name: "acme", components: [] } }, runtime), 2);
    assert.equal(await runPackageBuild({ ...base, package: { name: "acme", components: ["../x"] } }, runtime), 2);
    assert.equal(diagnostics.length, 4);
});

// --- receipt -----------------------------------------------------------------

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
            if (entry.isDirectory()) return filesUnder(root, absolute);
            const contents = fs.readFileSync(absolute);
            return [{ path: path.relative(root, absolute).split(path.sep).join("/"), sha256: sha256(contents), size: contents.length }];
        });
}

const REGISTRY_BUILDER = [
    "def relation_id(name, rule_kinds):",
    "    if name.startswith('cl-'):",
    "        return 'smart.' + name[3:]",
    "    return 'component.' + name",
    "",
].join("\n");

/** A ui checkout with one free release built from `sourceRevision`. */
function freeRelease(sourceRevision, reference)
{
    const ui = repository({
        "scripts/build-framework-registry.py": REGISTRY_BUILDER,
        "distr/rule/rule.json": `${JSON.stringify([
            { name: "icons", type: "component", tags: ["sf-icon"] },
            { name: "cl-buttons", type: "smart", tags: ["sf-button"] },
        ])}\n`,
    });
    const build = git(ui, "rev-parse", "HEAD");
    const id = `ui-${build.slice(0, 12)}`;
    commit(ui, {
        [`contracts/releases/${id}.lock.json`]: `${JSON.stringify({
            schema_version: 2,
            compatibility_id: id,
            runtime_sources: { core: { revision: build } },
            build_inputs: { source: { commit: sourceRevision } },
        })}\n`,
        ...(reference ? { "distr/core/contracts/packages/acme.package.json": `${JSON.stringify(reference)}\n` } : {}),
    }, "bind");
    return { id, ui };
}

/** A workspace as verify-package-reproducibility.cjs leaves it. */
function packageWorkspace(sourceRevision, rules)
{
    const product = repository({ "resources/ui/framework.lock.json": lock(sourceRevision) });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "package-workspace-"));
    const output = path.join(workspace, "wave-1/output/package/acme");
    for (const folder of Object.keys(rules).map(name => name.slice(3)))
    {
        writeFile(output, `smart/${folder}/js/${folder}.js`, `/* ${folder} */\n`);
        writeFile(output, `smart/${folder}/js/${folder}.js.gz`, "gz\n");
        if (rules[`cl-${folder}`].css) writeFile(output, `smart/${folder}/css/${folder}.css`, `.${folder}{}\n`);
    }
    writeFile(output, "smart/rule.js", renderPackageRuleFile("acme", rules));
    const files = filesUnder(output);
    writeFile(workspace, "report.json", `${JSON.stringify({
        builder: { clean: true, revision: "b".repeat(40), root: "/builder" },
        components: Object.keys(rules).map(name => name.slice(3)).sort(),
        node: "v20.19.5",
        output: "wave-1/output/package/acme",
        package: "acme",
        package_source: { path: "resources/ui", repository: "example/product-ui", revision: git(product, "rev-parse", "HEAD"), root: product },
        product: "package",
        products: { package: { byte_identical: true, files_count: files.length, manifest_sha256: sha256(`${JSON.stringify(files)}\n`) } },
        schema_version: 1,
        source_revision: sourceRevision,
        status: "PASS",
    }, null, 2)}\n`);
    return { output, product, workspace };
}

function receipt(workspace, ui)
{
    const result = spawnSync("python3", [RECEIPT_SCRIPT, "--report", path.join(workspace, "report.json"), ...(ui ? ["--ui", ui] : [])], { encoding: "utf8" });
    const file = path.join(workspace, "package-receipt.json");
    return { result, value: result.status === 0 ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}

const RULES = {
    "cl-gauge": { js: true, mode: "smart", relation: [{ name: "icons" }], tags: ["sf-gauge"], type: "smart" },
    "cl-widget": { css: true, js: true, mode: "smart", relation: [{ name: "cl-buttons" }, { name: "cl-gauge" }], tags: ["sf-widget"], type: "smart" },
};
const REFERENCE = {
    package: "acme",
    provides: [
        { id: "smart.gauge", element: "sf-gauge", rule_name: "cl-gauge", folder: "gauge", requires: ["component.icons"] },
        { id: "smart.widget", element: "sf-widget", rule_name: "cl-widget", folder: "widget", requires: ["smart.buttons", "smart.gauge"] },
    ],
};

test("the receipt names the package, its source, the free release, the builder and the output's hashes", () => {
    const source = "c".repeat(40);
    const { id, ui } = freeRelease(source, REFERENCE);
    const { output, product, workspace } = packageWorkspace(source, RULES);
    const { result, value } = receipt(workspace, ui);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value.schema_id, "simai.framework.product-package-receipt");
    assert.equal(value.schema_version, 1);
    assert.equal(value.package, "acme");
    assert.equal(value.loader.declaration, "SF_BOOT_CONFIG.packages.acme.base");
    assert.deepEqual(value.package_source, {
        repository: "example/product-ui",
        revision: git(product, "rev-parse", "HEAD"),
        path: "resources/ui",
        tree: git(product, "rev-parse", "HEAD:resources/ui"),
    });
    assert.deepEqual(value.framework, { source: { repository: "simai/ui-source", revision: source }, release: id });
    assert.deepEqual(value.builder, { repository: "simai/ui-builder", revision: "b".repeat(40), clean: true });
    assert.deepEqual(value.required_files.map(item => item.path), [
        "smart/rule.js", "smart/gauge/js/gauge.js", "smart/widget/js/widget.js", "smart/widget/css/widget.css",
    ]);
    assert.equal(value.required_files[0].sha256, sha256(fs.readFileSync(path.join(output, "smart/rule.js"))));
    assert.deepEqual(value.inventory.elements.map(item => [item.element, item.rule_name, item.folder, item.css]), [
        ["sf-gauge", "cl-gauge", "gauge", false],
        ["sf-widget", "cl-widget", "widget", true],
    ]);
    assert.deepEqual({ components: value.inventory.components, rules: value.inventory.rules }, { components: 2, rules: 2 });
    assert.deepEqual(value.package_reference, { path: "distr/core/contracts/packages/acme.package.json", release: id, status: "agrees" });
    const archive = fs.readFileSync(path.join(workspace, value.output.archive));
    assert.equal(value.output.archive_sha256, sha256(archive));
    assert.equal(value.output.files_count, value.files.length);

    // The archive is a function of the files alone.
    const again = receipt(workspace, ui);
    assert.equal(again.value.output.archive_sha256, value.output.archive_sha256);
    const listing = spawnSync("tar", ["-tvf", path.join(workspace, value.output.archive)], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /smart\/widget\/css\/widget\.css/u);
});

test("a missing package reference is a warning; a disagreeing one, a dangling relation or a free element fail", () => {
    const source = "d".repeat(40);
    const absent = freeRelease(source, null);
    const { workspace } = packageWorkspace(source, RULES);
    const warned = receipt(workspace, absent.ui);
    assert.equal(warned.result.status, 0, warned.result.stderr);
    assert.equal(warned.value.package_reference.status, "absent");
    assert.match(warned.result.stderr, /PACKAGE_RECEIPT_WARNING .* publishes no package reference/u);

    const wrong = freeRelease(source, { ...REFERENCE, provides: [REFERENCE.provides[0], { ...REFERENCE.provides[1], requires: ["smart.buttons"] }] });
    const refused = receipt(workspace, wrong.ui);
    assert.equal(refused.result.status, 1);
    assert.match(refused.result.stderr, /cl-widget: relations \['smart\.buttons', 'smart\.gauge'\], the reference requires \['smart\.buttons'\]/u);

    const dangling = packageWorkspace(source, { ...RULES, "cl-gauge": { ...RULES["cl-gauge"], relation: [{ name: "nowhere" }] } });
    assert.match(receipt(dangling.workspace, absent.ui).result.stderr, /relation nowhere is neither a package rule nor a rule of/u);

    const clash = packageWorkspace(source, { ...RULES, "cl-gauge": { ...RULES["cl-gauge"], tags: ["sf-button"] } });
    assert.match(receipt(clash.workspace, absent.ui).result.stderr, /<sf-button> is also an element of the free release/u);

    const none = freeRelease("e".repeat(40), null);
    const unreleased = receipt(workspace, none.ui);
    assert.equal(unreleased.result.status, 0, unreleased.result.stderr);
    assert.equal(unreleased.value.framework.release, null);
    assert.equal(unreleased.value.package_reference.status, "no-release");
});

test("the receipt refuses an output the report did not hash, or a rule file of another package", () => {
    const source = "f".repeat(40);
    const { output, workspace } = packageWorkspace(source, RULES);
    writeFile(output, "smart/gauge/js/gauge.js", "/* edited after the build */\n");
    assert.match(receipt(workspace).result.stderr, /is not the output the report hashed/u);

    const other = packageWorkspace(source, RULES);
    const report = JSON.parse(fs.readFileSync(path.join(other.workspace, "report.json"), "utf8"));
    writeFile(other.output, "smart/rule.js", renderPackageRuleFile("other", RULES));
    const files = filesUnder(other.output);
    report.products.package.manifest_sha256 = sha256(`${JSON.stringify(files)}\n`);
    writeFile(other.workspace, "report.json", JSON.stringify(report));
    assert.match(receipt(other.workspace).result.stderr, /registers package other, the build was acme/u);
});
