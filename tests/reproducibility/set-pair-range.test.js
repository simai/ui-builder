"use strict";

// Pair ranges: the SIMAI Framework interface a released component set takes
// from the free pair (set-pair-range.py write), and the pairs that keep it
// (set-pair-range.py check). Fixtures: a ui checkout with free pairs, a set
// release laid as its output and lock, and a set checkout with a Build commit.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { renderPackageRuleFile } = require("../../libs/packageProduct");

const RANGE = path.resolve(__dirname, "../../scripts/set-pair-range.py");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hex = (character, length) => character.repeat(length);
const run = (args) => spawnSync("python3", [RANGE, ...args], { encoding: "utf8" });

function write(root, relativePath, content)
{
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function git(root, ...args)
{
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function commit(root, files, message = "fixture")
{
    for (const [relativePath, content] of Object.entries(files)) write(root, relativePath, content);
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

const RUNTIME = {
    schema: "simai.framework.shared-runtime",
    version: 1,
    abi: 1,
    modules: { lit: { exports: ["html", "nothing", "css"] }, "smart-base": { exports: ["default"] } },
};
const JS_API = {
    schema: "simai.framework.public-js-api",
    schema_version: 1,
    globals: [
        { name: "SF.format", status: "public", members: ["number", "date"] },
        { name: "SF.runtimeModule", status: "public" },
        { name: "SF.RuleLoader", status: "public" },
        { name: "SF.runtimeLoading", status: "internal" },
    ],
};
const FREE_RULES = [
    { name: "cl-buttons", type: "smart", tags: ["sf-button"] },
    { name: "cl-empty-state", type: "smart", tags: ["sf-empty-state"] },
];
const CORE_CSS = ":root{--sf-space-1:4px;--sf-a2:#123;--sf-unused:1}\n";

/** One free pair in a ui checkout: distr at a build commit, its v2 lock bound after. */
function addPair(ui, { rules = FREE_RULES, runtime = RUNTIME, jsApi = JS_API, css = CORE_CSS, version = "1.30.0", forwards = null, smart = {} } = {})
{
    for (const entry of fs.readdirSync(ui)) if (entry === "distr") fs.rmSync(path.join(ui, entry), { recursive: true });
    const files = {
        "distr/rule/rule.json": rules,
        "distr/core/passports/core.runtime.json": { schema: "simai.framework.unit-passport", id: "core.runtime", version },
        "distr/core/css/core.css": css,
        "distr/core/css/core.min.css": ":root{--sf-only-in-min:1}\n",
        ...(runtime ? { "distr/core/contracts/shared-runtime.v1.json": runtime } : {}),
        ...(jsApi ? { "distr/core/contracts/public-js-api.json": jsApi } : {}),
        ...(forwards ? { "distr/core/contracts/smart-rule-forwards.v1.json": { version: 1, forwards } } : {}),
        ...smart,
    };
    const build = commit(ui, files, "build");
    const id = `ui-${build.slice(0, 12)}`;
    commit(ui, {
        [`contracts/releases/${id}.lock.json`]: {
            schema_version: 2,
            compatibility_id: id,
            runtime_sources: { core: { revision: build } },
            build_inputs: { source: { commit: sha256(id).slice(0, 40) } },
        },
    }, "bind");
    return id;
}

function newUi()
{
    const ui = fs.mkdtempSync(path.join(os.tmpdir(), "range-ui-"));
    git(ui, "init", "-q", "-b", "main");
    return ui;
}

const SET_RULES = {
    "cl-fx-gauge": {
        css: true, js: true, mode: "smart", tags: ["sf-fx-gauge"], type: "smart",
        relation: [{ name: "cl-empty-state" }, { name: "cl-fx-dial" }],
    },
    "cl-fx-dial": { css: true, js: false, mode: "smart", tags: ["sf-fx-dial"], type: "smart" },
};
const SET_JS = "const r=globalThis.SF;SF.runtimeModule('lit');SF.format.number(1);SF.runtimeLoading;SF.notListed.x;"
    + "el.style.setProperty('--sf-fx-own-js','1');x=`var(--sf-space-1)`;"
    + "h=`<sf-button></sf-button><sf-fx-dial></sf-fx-dial><sf-somewhere-else>`;document.createElement(\"sf-empty-state\");\n";
const SET_CSS = ".sf-fx-gauge{--sf-fx-gauge--size:var(--sf-space-1);color:var(--sf-a2);"
    + "margin:var(--sf-gone, 2px);padding:var(--sf-fx-gauge--size);border:var(--sf-page-bound);outline:var(--sf-only-in-min)}\n";

/** A set release laid out (output + lock) built over `pair`. */
function setRelease(pair, { rules = SET_RULES, receiptExtra = {}, passportExtra = {} } = {})
{
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "range-set-"));
    const output = path.join(work, "dist");
    write(output, "set.json", {
        id: "fx", repository: "example/ui-fx", framework: { core_runtime: ">=1.25.0", source_revision: hex("c", 40) },
        requires_sets: [], families: ["fx"], ...passportExtra,
    });
    write(output, "smart/rule.js", renderPackageRuleFile("fx", rules));
    write(output, "smart/fx-gauge/js/fx-gauge.js", SET_JS);
    write(output, "smart/fx-gauge/css/fx-gauge.css", SET_CSS);
    write(output, "smart/fx-dial/css/fx-dial.css", ".sf-fx-dial{--sf-fx-own-css:1}\n");
    const files = filesUnder(output);
    const receipt = {
        schema_id: "simai.framework.product-package-receipt",
        schema_version: 1,
        package: "fx",
        framework: { release: pair, runtime: { abi: 1, modules: { lit: ["html"], "smart-base": ["default"] } } },
        set: { id: "fx" },
        ...receiptExtra,
    };
    write(output, "package-receipt.json", receipt);
    const lock = {
        schema: "simai.framework.package-release-lock",
        schema_version: 1,
        id: `fx-${hex("a", 12)}`,
        package: "fx",
        version: "1.0.0",
        source: { repository: "example/ui-fx", path: "package", revision: hex("a", 40), tree: hex("1", 40) },
        build: { revision: hex("b", 40), path: "package/dist", tree: hex("2", 40), archive_sha256: hex("3", 64) },
        receipt: { path: "package/dist/package-receipt.json", sha256: sha256(fs.readFileSync(path.join(output, "package-receipt.json"))) },
        output: { manifest_sha256: sha256(`${JSON.stringify(files)}\n`), archive_sha256: hex("6", 64), files_count: files.length },
        requires: { framework: pair, source: hex("c", 40), core_runtime: ">=1.25.0" },
        requires_sets: [],
        builder: { repository: "simai/ui-builder", revision: hex("d", 40), clean: true },
        claims: { production_ready: false },
    };
    write(work, "lock.json", lock);
    return { work, output, lockPath: path.join(work, "lock.json"), lock };
}

function writeRange(ui, release, extra = [])
{
    const to = path.join(release.work, "range.json");
    const result = run(["write", "--output", release.output, "--lock", release.lockPath, "--ui", ui, "--as-of", "2026-11-09", "--to", to, ...extra]);
    return { result, to };
}

function checkPairs(ui, rangePath, pairs, extra = [])
{
    const result = run(["check", "--range", rangePath, "--ui", ui, ...pairs.flatMap((pair) => ["--pair", pair]), "--as-of", "2026-11-09", ...extra]);
    return { result, value: result.stdout ? JSON.parse(result.stdout) : null };
}

test("write takes exactly what the released bytes take from their own pair", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const release = setRelease(pair);
    const { result, to } = writeRange(ui, release);
    assert.equal(result.status, 0, result.stderr);
    const range = JSON.parse(fs.readFileSync(to, "utf8"));
    assert.equal(range.schema, "simai.framework.set-pair-range");
    assert.equal(range.release, release.lock.id);
    assert.equal(range.built_over.pair, pair);
    assert.deepEqual(range.requires, {
        core_runtime: ">=1.25.0",
        runtime: { abi: 1, modules: { lit: ["html"], "smart-base": ["default"] } },
        // The set's own cl-fx-dial is not a requirement of the pair.
        relations: [{ name: "cl-empty-state", resolves_to: "cl-empty-state" }],
        elements: ["sf-fx-dial", "sf-fx-gauge"],
        // Free tags the scripts render; not the set's own, not an unknown one.
        free_elements: ["sf-button", "sf-empty-state"],
        core_folder: null,
        // Bare reads the pair declares; not the set's own, not a read with a
        // fallback, not one only a minified sheet or the page declares.
        variables: ["--sf-a2", "--sf-space-1"],
        // Public names only; a member the contract lists, a global without members.
        js_api: ["RuleLoader", "format.number", "runtimeModule"],
    });
    assert.equal(range.interface_sha256, sha256(JSON.stringify(sortKeys(range.requires))));
    assert.deepEqual(range.tooling.notes.variables_bound_by_the_page, ["--sf-only-in-min", "--sf-page-bound"]);
    assert.deepEqual(range.tooling.notes.js_names_not_public, ["SF.notListed", "SF.runtimeLoading"]);
    assert.equal(range.expires, null);
    assert.equal(range.package.receipt_sha256, release.lock.receipt.sha256);
});

function sortKeys(value)
{
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
    return value;
}

test("write refuses an output that is not the release, and a release its own pair does not resolve", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const release = setRelease(pair);
    fs.appendFileSync(path.join(release.output, "smart/fx-gauge/js/fx-gauge.js"), "// changed\n");
    const changed = writeRange(ui, release).result;
    assert.equal(changed.status, 2);
    assert.match(changed.stderr, /is not the released output/u);

    const orphan = setRelease(pair, { rules: { "cl-fx-gauge": { ...SET_RULES["cl-fx-gauge"], relation: [{ name: "cl-nowhere" }] }, "cl-fx-dial": SET_RULES["cl-fx-dial"] } });
    const refused = writeRange(ui, orphan).result;
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /relation cl-nowhere is no rule of ui-/u);
});

test("check: a later pair that keeps the interface is within, whatever else it changes", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const release = setRelease(pair);
    const { to } = writeRange(ui, release);
    const later = addPair(ui, {
        version: "1.42.0",
        rules: [...FREE_RULES, { name: "cl-new", type: "smart", tags: ["sf-new"] }],
        runtime: { ...RUNTIME, modules: { ...RUNTIME.modules, lit: { exports: ["html", "nothing", "css", "svg"] }, "page-language": { exports: ["pageLocale"] } } },
        css: ":root{--sf-space-1:6px;--sf-a2:#456;--sf-new:1}\n",
    });
    const { result, value } = checkPairs(ui, to, [pair, later], ["--lock", release.lockPath]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(value.pairs.map((item) => [item.pair, item.status]), [[pair, "within"], [later, "within"]]);
    assert.equal(value.pairs[0].basis, "built-over");
});

test("check: each break of the interface puts a pair outside, with its reason", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const release = setRelease(pair);
    const { to } = writeRange(ui, release);
    const cases = [
        [{ version: "1.24.9" }, /core_runtime: .* runs 1\.24\.9, the set needs >=1\.25\.0/u],
        [{ runtime: { ...RUNTIME, abi: 2 } }, /runtime: ABI 2, the set was built for ABI 1/u],
        [{ runtime: { ...RUNTIME, modules: { lit: { exports: ["nothing"] }, "smart-base": { exports: ["default"] } } } }, /lit no longer exports html/u],
        [{ runtime: { ...RUNTIME, modules: { lit: RUNTIME.modules.lit } } }, /does not hand out smart-base/u],
        [{ runtime: null }, /publishes no distr\/core\/contracts\/shared-runtime\.v1\.json/u],
        [{ rules: [FREE_RULES[0]] }, /relations: cl-empty-state is no rule of/u],
        [{ rules: [FREE_RULES[1]] }, /free_elements: .* has no free element sf-button/u],
        [{ rules: [...FREE_RULES, { name: "cl-other", type: "smart", tags: ["sf-fx-dial"] }] }, /elements: .* has free elements sf-fx-dial/u],
        [{ css: ":root{--sf-space-1:4px}\n" }, /variables: .* no longer declares --sf-a2/u],
        [{ jsApi: { ...JS_API, globals: JS_API.globals.map((item) => item.name === "SF.format" ? { ...item, members: ["date"] } : item) } }, /js_api: .* no longer lists as public SF\.format\.number/u],
        [{ jsApi: { ...JS_API, globals: JS_API.globals.map((item) => item.name === "SF.RuleLoader" ? { ...item, status: "internal" } : item) } }, /SF\.RuleLoader/u],
    ];
    for (const [change, pattern] of cases)
    {
        const broken = addPair(ui, change);
        const { result, value } = checkPairs(ui, to, [broken]);
        assert.equal(result.status, 1, `${JSON.stringify(change)}: ${result.stderr}`);
        assert.equal(value.pairs[0].status, "outside");
        assert.match(value.pairs[0].problems.join("\n"), pattern, JSON.stringify(change));
    }
});

test("check: a renamed rule keeps a pair within while its forward is live, and not after", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const release = setRelease(pair);
    const { to } = writeRange(ui, release);
    const renamed = addPair(ui, {
        // A renamed element keeps its former tag as a dated alias, after its own.
        rules: [FREE_RULES[0], { name: "cl-empty", type: "smart", tags: ["sf-empty", "sf-empty-state"] }],
        forwards: { "cl-empty-state": { to: "cl-empty", since: "2026-11-08", remove_after: "2027-01-01", journal: "rename-empty-state" } },
    });
    assert.equal(checkPairs(ui, to, [renamed]).value.pairs[0].status, "within");
    const late = run(["check", "--range", to, "--ui", ui, "--pair", renamed, "--as-of", "2027-01-02"]);
    assert.equal(late.status, 1);
    assert.match(late.stdout, /the forward has expired/u);
});

test("check: a package core the pair now ships puts it outside", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const rules = { ...SET_RULES, "cl-fx-core": { css: false, js: true, mode: "smart", tags: [], type: "smart" } };
    const release = setRelease(pair, { rules, receiptExtra: { core: { folder: "fx-core", rule: "cl-fx-core" } } });
    const { result, to } = writeRange(ui, release);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(to, "utf8")).requires.core_folder, "fx-core");
    const shipping = addPair(ui, { smart: { "distr/smart/fx-core/js/fx-core.js": "core\n" } });
    const { value } = checkPairs(ui, to, [shipping]);
    assert.match(value.pairs[0].problems.join("\n"), /core_folder: .* ships distr\/smart\/fx-core/u);
});

test("check refuses a range that was edited or describes another release", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const release = setRelease(pair);
    const { to } = writeRange(ui, release);
    const range = JSON.parse(fs.readFileSync(to, "utf8"));
    write(release.work, "loosened.json", { ...range, requires: { ...range.requires, variables: [] } });
    const loosened = run(["check", "--range", path.join(release.work, "loosened.json"), "--ui", ui, "--pair", pair]);
    assert.equal(loosened.status, 2);
    assert.match(loosened.stderr, /interface_sha256 is not the digest of its requires/u);

    write(release.work, "other-lock.json", { ...release.lock, output: { ...release.lock.output, archive_sha256: hex("7", 64) } });
    const other = run(["check", "--range", to, "--ui", ui, "--pair", pair, "--lock", path.join(release.work, "other-lock.json")]);
    assert.equal(other.status, 2);
    assert.match(other.stderr, /package\.archive_sha256 .* the lock says 7{64}/u);

    write(release.work, "extra.json", { ...range, pairs: [pair] });
    const extra = run(["check", "--range", path.join(release.work, "extra.json"), "--ui", ui, "--pair", pair]);
    assert.equal(extra.status, 2);
    assert.match(extra.stderr, /is not a simai\.framework\.set-pair-range v1/u);
});

test("write from a set checkout reads the released output at the Build commit", () => {
    const ui = newUi();
    const pair = addPair(ui);
    const laid = setRelease(pair);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "range-repo-"));
    git(repo, "init", "-q", "-b", "main");
    fs.cpSync(laid.output, path.join(repo, "package/dist"), { recursive: true });
    const build = commit(repo, {}, "Build");
    const lock = { ...laid.lock, build: { ...laid.lock.build, revision: build, tree: git(repo, "rev-parse", `${build}:package/dist`) } };
    commit(repo, { [`contracts/releases/${lock.id}.lock.json`]: lock }, "Bind");
    const to = path.join(laid.work, "from-repo.json");
    const result = run(["write", "--repo", repo, "--release", lock.id, "--ui", ui, "--as-of", "2026-11-09", "--to", to]);
    assert.equal(result.status, 0, result.stderr);
    const range = JSON.parse(fs.readFileSync(to, "utf8"));
    assert.equal(range.package.build_revision, build);
    assert.equal(range.interface_sha256, JSON.parse(fs.readFileSync(writeRange(ui, laid).to, "utf8")).interface_sha256);
});

// A product package released with no lock (Pro: package-pro.tar beside
// package-receipt.json on a pro-<12> release). Its range is the same document,
// read by the same code; the receipt gives what a lock gives a set.
const PRO_RULES = {
    "cl-fx-board": {
        css: true, js: true, mode: "smart", tags: ["sf-fx-board", "sf-fx-old-board"], type: "smart",
        relation: [{ name: "cl-empty-state" }, { name: "cl-buttons" }, { name: "cl-fx-cell" }],
    },
    "cl-fx-cell": { css: true, js: false, mode: "smart", tags: ["sf-fx-cell"], type: "smart" },
};

function proRelease(pair, { rules = PRO_RULES, receiptExtra = {} } = {})
{
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "range-pro-"));
    const output = path.join(work, "tree");
    write(output, "smart/rule.js", renderPackageRuleFile("pro", rules));
    write(output, "smart/fx-board/js/fx-board.js", SET_JS);
    write(output, "smart/fx-board/css/fx-board.css", SET_CSS.replaceAll("fx-gauge", "fx-board"));
    write(output, "smart/fx-cell/css/fx-cell.css", ".sf-fx-cell{--sf-fx-own-css:1}\n");
    const files = filesUnder(output);
    const archive = path.join(work, "package-pro.tar");
    const packed = spawnSync("python3", ["-I", "-c",
        "import sys,tarfile\nwith tarfile.open(sys.argv[1],'w',format=tarfile.USTAR_FORMAT) as t: t.add(sys.argv[2],arcname='smart')",
        archive, path.join(output, "smart")], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const receipt = {
        schema_id: "simai.framework.product-package-receipt",
        schema_version: 1,
        package: "pro",
        package_source: { repository: "simai/ui-pro", revision: hex("e", 40), path: "components", tree: hex("4", 40) },
        framework: { source: { repository: "simai/ui-source", revision: hex("c", 40) }, release: pair,
            runtime: { abi: 1, modules: { lit: ["html"], "smart-base": ["default"] } } },
        output: { runtime_path: "smart", files_count: files.length, manifest_sha256: sha256(`${JSON.stringify(files)}\n`),
            archive: "package-pro.tar", archive_sha256: sha256(fs.readFileSync(archive)) },
        claims: { production_ready: false },
        ...receiptExtra,
    };
    write(work, "package-receipt.json", receipt);
    return { work, archive, receiptPath: path.join(work, "package-receipt.json"), receipt };
}

function writeProRange(ui, release, extra = [])
{
    const to = path.join(release.work, "pair-range.json");
    const result = run(["write", "--receipt", release.receiptPath, "--archive", release.archive, "--ui", ui, "--as-of", "2026-11-09", "--to", to, ...extra]);
    return { result, to };
}

test("write: a product package from its receipt and archive, the core.runtime floor its own pair's", () => {
    const ui = newUi();
    const pair = addPair(ui, { version: "1.45.0" });
    const release = proRelease(pair);
    const { result, to } = writeProRange(ui, release);
    assert.equal(result.status, 0, result.stderr);
    const range = JSON.parse(fs.readFileSync(to, "utf8"));
    // The same document a set has, with the same keys.
    assert.deepEqual(Object.keys(range).sort(), ["built_over", "claims", "created_on", "expires", "interface_sha256", "not_covered",
        "package", "release", "repository", "requires", "schema", "schema_version", "set", "tooling", "version"]);
    assert.equal(range.set, "pro");
    assert.equal(range.release, `pro-${hex("e", 12)}`);
    assert.equal(range.version, null);
    assert.equal(range.repository, "simai/ui-pro");
    assert.deepEqual(range.package, {
        source_revision: hex("e", 40), build_revision: hex("e", 40),
        receipt_sha256: sha256(fs.readFileSync(release.receiptPath)), manifest_sha256: release.receipt.output.manifest_sha256,
        archive_sha256: release.receipt.output.archive_sha256, files_count: release.receipt.output.files_count,
    });
    assert.deepEqual(range.built_over.source_revision, hex("c", 40));
    assert.deepEqual(range.requires, {
        core_runtime: ">=1.45.0",
        runtime: { abi: 1, modules: { lit: ["html"], "smart-base": ["default"] } },
        relations: [{ name: "cl-buttons", resolves_to: "cl-buttons" }, { name: "cl-empty-state", resolves_to: "cl-empty-state" }],
        // No package core: every tag, its former ones too.
        elements: ["sf-fx-board", "sf-fx-cell", "sf-fx-old-board"],
        free_elements: ["sf-button", "sf-empty-state"],
        core_folder: null,
        variables: ["--sf-a2", "--sf-space-1"],
        js_api: ["RuleLoader", "format.number", "runtimeModule"],
    });
    assert.equal(range.interface_sha256, sha256(JSON.stringify(sortKeys(range.requires))));
    assert.match(range.not_covered.at(-1), /packages\/pro\.package\.json/u);
});

test("check: a product package range against later pairs, its receipt, and a consumer's package lock", () => {
    const ui = newUi();
    const pair = addPair(ui, { version: "1.45.0" });
    const release = proRelease(pair);
    const { to } = writeProRange(ui, release);
    const later = addPair(ui, { version: "1.46.0", css: ":root{--sf-space-1:6px;--sf-a2:#456;--sf-new:1}\n" });
    const older = addPair(ui, { version: "1.44.0" });
    const { result, value } = checkPairs(ui, to, [pair, later, older], ["--receipt", release.receiptPath]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(value.pairs.map((item) => [item.pair, item.status]), [[pair, "within"], [later, "within"], [older, "outside"]]);
    assert.match(value.pairs[2].problems.join("\n"), /core_runtime: .* runs 1\.44\.0, the set needs >=1\.45\.0/u);

    // A consumer that pins packages by lock (Larena) describes the release as a package release lock.
    const range = JSON.parse(fs.readFileSync(to, "utf8"));
    const consumerLock = {
        schema: "simai.framework.package-release-lock", schema_version: 1, id: range.release, package: "pro", version: null,
        source: { repository: "simai/ui-pro", revision: hex("e", 40) }, receipt: { sha256: range.package.receipt_sha256 },
        output: { manifest_sha256: range.package.manifest_sha256, archive_sha256: range.package.archive_sha256 },
        requires: { framework: pair },
    };
    write(release.work, "consumer-lock.json", consumerLock);
    assert.equal(checkPairs(ui, to, [later], ["--lock", path.join(release.work, "consumer-lock.json")]).result.status, 0);

    const other = proRelease(pair, { receiptExtra: { package_source: { ...release.receipt.package_source, revision: hex("f", 40) } } });
    const refused = run(["check", "--range", to, "--ui", ui, "--pair", pair, "--receipt", other.receiptPath]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /release pro-e{12}, the lock says pro-f{12}/u);
});

test("write refuses a package archive its receipt does not name, and a set receipt without a lock", () => {
    const ui = newUi();
    const pair = addPair(ui, { version: "1.45.0" });
    const release = proRelease(pair);
    fs.appendFileSync(release.archive, "x");
    const changed = writeProRange(ui, release).result;
    assert.equal(changed.status, 2);
    assert.match(changed.stderr, /is not the archive pro-e{12} names/u);

    const set = proRelease(pair, { receiptExtra: { set: { id: "pro" } } });
    const asSet = writeProRange(ui, set).result;
    assert.equal(asSet.status, 2);
    assert.match(asSet.stderr, /a set is released with a lock/u);

    const usage = run(["write", "--receipt", release.receiptPath, "--ui", ui]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /--receipt with --archive/u);
});
