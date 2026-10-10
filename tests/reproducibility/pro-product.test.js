"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    PRO_COMPONENTS,
    collectProRules,
    materializeProOverlay,
    renderPackageRuleFile,
} = require("../../libs/proProduct");

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

function repository(files)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pro-product-"));
    git(root, "init", "-q");
    for (const [relativePath, content] of Object.entries(files)) writeFile(root, relativePath, content);
    git(root, "add", "-A");
    git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture");
    return root;
}

function rule(name, extra = "")
{
    return `SF.RuleLoader["cl-${name}"] = {tags: ["sf-${name}"], type: "smart", mode: "smart", js: true, ${extra}relation: [{name: "icons"}]};\n`;
}

function proFiles(sourceRevision, extra = {})
{
    const files = {
        "framework.lock.json": JSON.stringify({
            schema: "simai.framework-pro.source-lock.v1",
            source: { repository: "simai/ui-source", revision: sourceRevision },
        }),
        ...extra,
    };
    for (const name of PRO_COMPONENTS)
    {
        files[`src/smart/${name}/index.js`] = `import "../helpers/dom";\n`;
        files[`src/smart/${name}/rule.js`] = rule(name);
    }
    return files;
}

test("the package rule file registers exactly the four Pro rules, as sorted plain data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pro-rules-"));
    for (const name of [...PRO_COMPONENTS].reverse()) writeFile(root, `smart/${name}/rule.js`, rule(name));
    const rules = collectProRules(root);
    assert.deepEqual(Object.keys(rules), PRO_COMPONENTS.map(name => `cl-${name}`));
    assert.deepEqual(Object.keys(rules["cl-table"]), ["js", "mode", "relation", "tags", "type"]);
    const rendered = renderPackageRuleFile(rules);
    assert.match(rendered, /^\/\/ SIMAI Framework Pro: the package rule file\./u);
    assert.match(rendered, /\nSF\.RuleLoader\.registerPackage\("pro", \{\n {2}rules: \{/u);
    assert.equal(rendered, renderPackageRuleFile(collectProRules(root)), "rendering is deterministic");

    const registered = [];
    // The file is a script the Loader runs: one call, with the rules as data.
    new Function("SF", rendered)({ RuleLoader: { registerPackage: (name, value) => registered.push([name, value]) } });
    assert.deepEqual(JSON.parse(JSON.stringify(registered)), [["pro", { rules: JSON.parse(JSON.stringify(rules)) }]]);
});

test("a Pro rule.js must write its own rule, and no package field", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pro-rules-"));
    for (const name of PRO_COMPONENTS) writeFile(root, `smart/${name}/rule.js`, rule(name));
    writeFile(root, "smart/table/rule.js", rule("table") + rule("extra"));
    assert.throws(() => collectProRules(root), /must write exactly cl-table/u);
    writeFile(root, "smart/table/rule.js", rule("table", 'package: "pro", '));
    assert.throws(() => collectProRules(root), /without a package field/u);
    writeFile(root, "smart/table/rule.js", rule("table", "regex: /x/, "));
    assert.throws(() => collectProRules(root), /not plain data/u);
});

test("the overlay is ui-source at the pin with ui-source-pro laid over it, from git", () => {
    const uiSource = repository({
        "package.json": "{}\n",
        "src/smart/helpers/dom.js": "export const dom = 1;\n",
        "src/smart/buttons/index.js": "export default 1;\n",
    });
    const pin = git(uiSource, "rev-parse", "HEAD");
    writeFile(uiSource, "src/smart/helpers/dom.js", "a working-tree edit that must not leak\n");
    const pro = repository(proFiles(pin, { "tests/table.test.mjs": "\n", "README.md": "not laid\n" }));
    const overlayRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pro-overlay-")), "overlay");

    const result = materializeProOverlay({ overlayRoot, proRoot: pro, uiSourceRoot: uiSource });
    assert.equal(result.source_revision, pin);
    assert.equal(result.pro_revision, git(pro, "rev-parse", "HEAD"));
    assert.equal(fs.readFileSync(path.join(overlayRoot, "src/smart/helpers/dom.js"), "utf8"), "export const dom = 1;\n");
    assert.ok(fs.existsSync(path.join(overlayRoot, "src/smart/table/index.js")));
    assert.ok(fs.existsSync(path.join(overlayRoot, "tests/table.test.mjs")));
    assert.ok(!fs.existsSync(path.join(overlayRoot, "README.md")), "only src, tests and docs are laid");
    assert.throws(() => materializeProOverlay({ overlayRoot, proRoot: pro, uiSourceRoot: uiSource }), /must not exist/u);
});

test("ui-source-pro may not replace a ui-source file", () => {
    const uiSource = repository({ "package.json": "{}\n", "src/smart/helpers/dom.js": "export const dom = 1;\n" });
    const pin = git(uiSource, "rev-parse", "HEAD");
    const pro = repository(proFiles(pin, { "src/smart/helpers/dom.js": "a shadow\n" }));
    const overlayRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pro-overlay-")), "overlay");
    assert.throws(
        () => materializeProOverlay({ overlayRoot, proRoot: pro, uiSourceRoot: uiSource }),
        /would replace ui-source's src\/smart\/helpers\/dom\.js/u,
    );
});

test("the pin must be a full ui-source revision the checkout holds", () => {
    const uiSource = repository({ "package.json": "{}\n" });
    const pro = repository(proFiles("0".repeat(40)));
    const overlayRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pro-overlay-")), "overlay");
    assert.throws(() => materializeProOverlay({ overlayRoot, proRoot: pro, uiSourceRoot: uiSource }), /cat-file/u);
    const short = repository(proFiles("abc123"));
    assert.throws(() => materializeProOverlay({ overlayRoot, proRoot: short, uiSourceRoot: uiSource }), /full commit/u);
});
