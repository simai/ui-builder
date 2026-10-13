"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { undeclaredRelations, drawnTags } = require("../../libs/packageRelations");

// A package component that draws a Framework element without a relation to
// its rule renders before the element's styles arrive, whenever nothing else
// on the page pulled the rule in (the documentation trial: sf-button unstyled
// in 3 of 12 cold loads). sf-build warns, reading the component's source.

function tree(files)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-relations-"));
    for (const [file, content] of Object.entries(files))
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    }
    return root;
}

const framework = () => tree({
    "src/smart/buttons/rule.js": "SF.RuleLoader['cl-buttons'] = { tags: ['sf-button'], type: 'smart' };\n",
    "src/smart/icons/rule.js": "SF.RuleLoader['cl-icons'] = { tags: ['sf-icon'], type: 'smart' };\n",
    "src/smart/radio/rule.js": "SF.RuleLoader['cl-radio'] = { tags: ['sf-radio'], type: 'smart' };\n",
    "src/smart/icon-buttons/rule.js": "SF.RuleLoader['cl-icon-buttons'] = { tags: ['sf-icon-button'], type: 'smart' };\n",
});

test("a component drawing a Framework element without its relation is named, with the rule to add", () =>
{
    const pkg = tree({
        "src/smart/card/rule.js": "SF.RuleLoader['acme-card'] = { tags: ['acme-card'], relation: [{ name: 'cl-icons' }] };\n",
        "src/smart/card/js/templates/default.js": "html`<div class=\"sf-icon\"><sf-button text=\"Go\"></sf-button><sf-icon icon=\"add\"></sf-icon></div>`",
    });
    const warnings = undeclaredRelations({ packageRoot: pkg, uiSource: framework() });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^acme-card draws <sf-button> without a relation to cl-buttons/u);
    assert.match(warnings[0], /add \{name: 'cl-buttons'\}/u);
});

test("declared, lazy, ensured and own elements are not warned about; a class name is not a tag", () =>
{
    const pkg = tree({
        "src/smart/card/rule.js": "SF.RuleLoader['acme-card'] = { tags: ['acme-card'], relation: [{ name: 'cl-buttons' }, { name: 'cl-icon-buttons', lazy: true }] };\n",
        "src/smart/card/index.js": [
            "el.className = 'sf-icon';",
            "const b = SF.create('sf-button', {});",
            "const i = {component: {type: 'icon-button', props: {}}};",
            "await SF.Loader?.ensureSmartElementLoaded?.('sf-radio'); document.createElement('sf-radio');",
            "document.createElement('acme-badge');",
        ].join("\n"),
        "src/smart/badge/rule.js": "SF.RuleLoader['acme-badge'] = { tags: ['acme-badge'] };\n",
    });
    assert.deepEqual(undeclaredRelations({ packageRoot: pkg, uiSource: framework() }), []);
});

test("the tags a source draws: templates, made elements and component descriptors", () =>
{
    const tags = drawnTags("html`<sf-button></sf-button>` + SF.create('sf-tags') + {component: {type: 'icon-button'}} + 'sf-icon'");
    assert.deepEqual([...tags].sort(), ["sf-button", "sf-icon-button", "sf-tags"]);
});
