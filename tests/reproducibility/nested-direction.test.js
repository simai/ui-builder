"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const postcss = require("postcss");
const presetEnv = require("postcss-preset-env");
const cleanup = require("../../libs/postcssLateLogicalFallbacks");
const { createPostcssPresetEnvOptions } = require("../../libs/postcssPolicy");

// No browser dependency is added to the builder. CI can set SF_TEST_BROWSER.
const browser = process.env.SF_TEST_BROWSER || [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
].find(candidate => fs.existsSync(candidate));

const INPUT = `
.base { margin: 3px; padding: 5px; }
.ms { margin-inline-start: var(--space, 11px); }
.me { margin-inline-end: var(--space, 11px); }
.negative { margin-inline-start: calc(-1 * var(--space, 11px)); }
.ps { padding-inline-start: var(--space, 11px); }
.pe { padding-inline-end: var(--space, 11px); }
`;

function documentFor(variants)
{
    return `<!doctype html><html><head><style id="fixture-style"></style></head><body>
<script>
const results = [];
const contexts = [[], ['ltr'], ['rtl'], ['ltr','rtl'], ['rtl','ltr'],
    ['ltr','rtl','ltr'], ['rtl','ltr','rtl']];
for (const { mode, css, variable } of ${JSON.stringify(variants)}) {
    document.getElementById("fixture-style").textContent = css;
for (const directions of contexts) {
    for (const ownDir of [false, true]) {
        for (const family of ['ms','me','negative','ps','pe']) {
            let parent = document.body;
            const pageDirection = directions[0];
            document.documentElement.removeAttribute('dir');
            if (pageDirection) document.documentElement.dir = pageDirection;
            const nested = directions.slice(1);
            for (const direction of ownDir ? nested.slice(0, -1) : nested) {
                const container = document.createElement('section');
                container.dir = direction;
                parent.append(container);
                parent = container;
            }
            const element = document.createElement('div');
            element.className = 'base ' + family;
            if (ownDir && nested.length) element.dir = nested.at(-1);
            if (variable) element.style.setProperty("--space", "19px");
            parent.append(element);
            const style = getComputedStyle(element);
            results.push({ mode, variable, directions, ownDir, family, direction: style.direction,
                ltr: element.matches(':dir(ltr)'), rtl: element.matches(':dir(rtl)'),
                margin: [style.marginLeft, style.marginRight],
                padding: [style.paddingLeft, style.paddingRight] });
            document.body.replaceChildren();
        }
    }
}
}
const output = document.createElement('pre');
output.id = 'results';
output.textContent = JSON.stringify(results);
document.body.append(output);
</script></body></html>`;
}

test("computed sides follow nearest dir with full CSS and physical fallbacks alone", {
    skip: browser ? false : "Set SF_TEST_BROWSER to a Chrome/Chromium executable",
}, async () => {
    const result = await postcss([
        presetEnv(createPostcssPresetEnvOptions({ browsers: "last 1 version, >1%" })),
        cleanup(),
    ]).process(INPUT, { from: undefined });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-nested-direction-"));
    try
    {
        const variants = [];
        for (const mode of ["full", "physical", "constant"])
        {
            const root = result.root.clone();
            if (mode !== "full")
            {
                root.walkDecls(declaration => {
                    if (/inline|^-webkit-(margin|padding)-/.test(declaration.prop)
                        || (mode === "constant" && declaration.value.includes("var(")))
                    {
                        declaration.remove();
                    }
                });
            }
            for (const variable of [false, true])
            {
                variants.push({ mode, variable, css: root.toString() });
            }
        }
        const input = path.join(workspace, "fixture.html");
        fs.writeFileSync(input, documentFor(variants));
        const output = path.join(workspace, "result.html");
        const diagnostics = path.join(workspace, "browser.log");
        const stdout = fs.openSync(output, "w");
        const stderr = fs.openSync(diagnostics, "w");
        let run;
        try
        {
            // Regular files avoid Chromium's large dump being truncated in a pipe.
            run = spawnSync(browser, [
                "--headless", "--no-sandbox", "--disable-gpu",
                "--disable-crashpad-for-testing",
                "--no-first-run", "--no-default-browser-check",
                "--disable-search-engine-choice-screen", "--use-mock-keychain",
                `--user-data-dir=${path.join(workspace, "profile")}`,
                "--dump-dom", pathToFileURL(input).href,
            ], { stdio: ["ignore", stdout, stderr], timeout: 30000 });
        }
        finally
        {
            fs.closeSync(stdout);
            fs.closeSync(stderr);
        }
        assert.ifError(run.error);
        assert.equal(run.status, 0, fs.readFileSync(diagnostics, "utf8"));
        const html = fs.readFileSync(output, "utf8");
        const match = html.match(/<pre id="results">([^<]+)<\/pre>/);
        assert.ok(match, "Browser must return the complete computed-style matrix");
        const rows = JSON.parse(match[1]);
        assert.equal(rows.length, 420);
        for (const row of rows)
        {
            const { mode, variable } = row;
            const direction = row.directions.at(-1) || "ltr";
            const start = direction === "ltr" ? 0 : 1;
            const value = variable && mode !== "constant" ? 19 : 11;
            const expected = { margin: ["3px", "3px"], padding: ["5px", "5px"] };
            const property = row.family.startsWith("p") ? "padding" : "margin";
            const side = row.family.endsWith("e") && row.family !== "negative"
                ? 1 - start : start;
            expected[property][side] = `${row.family === "negative" ? -value : value}px`;
            const label = JSON.stringify(row);
            assert.equal(row.direction, direction, label);
            assert.equal(row.ltr, direction === "ltr", label);
            assert.equal(row.rtl, direction === "rtl", label);
            assert.deepEqual(row.margin, expected.margin, label);
            assert.deepEqual(row.padding, expected.padding, label);
        }
    }
    finally
    {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
