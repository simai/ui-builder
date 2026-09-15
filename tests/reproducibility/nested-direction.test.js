"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
.later { margin: 7px; padding: 9px; }
`;

function documentFor(variants)
{
    return `<!doctype html><html><head><style id="fixture-style"></style></head><body>
<script>
const results = [];
const combinations = [];
const contexts = [[], ['ltr'], ['rtl'], ['ltr','rtl'], ['rtl','ltr']];
for (const { mode, css, variable } of ${JSON.stringify(variants)}) {
    document.getElementById("fixture-style").textContent = css;
for (const directions of (mode.startsWith("legacy") ? contexts.slice(0, 3) : contexts)) {
    if (mode === "full") {
        for (const classes of ['base ms me', 'base ps pe', 'base ms later', 'base ps later', 'base negative me']) {
            document.documentElement.dir = directions[0] || 'ltr';
            let parent = document.body;
            for (const direction of directions.slice(1)) {
                const container = document.createElement('section');container.dir = direction;
                parent.append(container);parent = container;
            }
            const element = document.createElement('div');element.className = classes;
            if (variable) element.style.setProperty('--space', '19px');
            parent.append(element);const style = getComputedStyle(element);
            combinations.push({mode,variable,directions,classes,margin:[style.marginLeft,style.marginRight],padding:[style.paddingLeft,style.paddingRight]});
            document.body.replaceChildren();
        }
    }
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
output.textContent = JSON.stringify({results, combinations});
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
            for (const variable of mode === "full" ? [false, true] : [false])
            {
                variants.push({ mode, variable, css: root.toString() });
            }
        }
        for (const mode of ["legacy-ie", "legacy-supports", "legacy-webkit"])
        {
            const root = result.root.clone();
            root.walkAtRules("supports", rule => {
                if (mode === "legacy-supports") rule.replaceWith(...rule.nodes);
                else rule.remove();
            });
            root.walkRules(rule => {
                if (rule.selector.includes(":dir(")) rule.remove();
                else if (rule.selector.startsWith("_:-ms-input-placeholder,"))
                {
                    if (mode === "legacy-ie") rule.selector = rule.selector.replace(/^_:-ms-input-placeholder, /, "");
                    else rule.remove();
                }
            });
            root.walkDecls(decl => {
                if (decl.prop.includes("inline") || decl.value.includes("var(")
                    || (mode !== "legacy-webkit" && decl.prop.startsWith("-webkit-"))) decl.remove();
            });
            variants.push({mode, variable: false, css: root.toString()});
        }
        const input = path.join(workspace, "fixture.html");
        fs.writeFileSync(input, documentFor(variants));
        const output = path.join(workspace, "result.html");
        const diagnostics = path.join(workspace, "browser.log");
        const stdout = fs.openSync(output, "w");
        const stderr = fs.openSync(diagnostics, "w");
        let child;
        let browserError = null;
        let browserExited;
        let match;
        try
        {
            // Regular files avoid Chromium's large dump being truncated in a pipe.
            child = spawn(browser, [
                "--headless=new", "--no-sandbox", "--disable-gpu",
                "--disable-crashpad-for-testing",
                "--disable-background-networking", "--disable-component-update",
                "--disable-sync", "--metrics-recording-only",
                "--no-first-run", "--no-default-browser-check",
                "--disable-search-engine-choice-screen", "--use-mock-keychain",
                `--user-data-dir=${path.join(workspace, "profile")}`,
                "--dump-dom", pathToFileURL(input).href,
            ], { stdio: ["ignore", stdout, stderr] });
            browserExited = new Promise(resolve => child.once("close", resolve));
            child.once("error", error => { browserError = error; });
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline)
            {
                match = fs.readFileSync(output, "utf8").match(/<pre id="results">([^<]+)<\/pre>/);
                if (match) break;
                if (browserError) throw browserError;
                if (child.exitCode !== null || child.signalCode !== null)
                {
                    assert.fail(`Browser exited before the complete matrix: ${fs.readFileSync(diagnostics, "utf8")}`);
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            if (!match)
            {
                assert.fail(`Browser did not return the complete matrix within 120 seconds: ${fs.readFileSync(diagnostics, "utf8")}`);
            }
        }
        finally
        {
            if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            if (browserExited) await browserExited;
            fs.closeSync(stdout);
            fs.closeSync(stderr);
        }
        assert.ok(match, "Browser must return the complete computed-style matrix");
        const { results: rows, combinations } = JSON.parse(match[1]);
        assert.equal(rows.filter(row => !row.mode.startsWith("legacy")).length, 200);
        assert.equal(rows.filter(row => row.mode.startsWith("legacy")).length, 90);
        assert.equal(combinations.length, 50);
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
        for (const row of combinations)
        {
            const start = (row.directions.at(-1) || "ltr") === "ltr" ? 0 : 1;
            const value = row.variable && row.mode !== "constant" ? 19 : 11;
            let margin = ["3px", "3px"], padding = ["5px", "5px"];
            if (row.classes === "base ms me") margin = [`${value}px`, `${value}px`];
            if (row.classes === "base ps pe") padding = [`${value}px`, `${value}px`];
            if (row.classes.includes("later")) { margin = ["7px", "7px"]; padding = ["9px", "9px"]; }
            if (row.classes === "base negative me") { margin[start] = `${-value}px`; margin[1 - start] = `${value}px`; }
            assert.deepEqual(row.margin, margin, JSON.stringify(row));
            assert.deepEqual(row.padding, padding, JSON.stringify(row));
        }
    }
    finally
    {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
