"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    createBuildPlan,
} = require("../../libs/buildPlan");

const STANDARD_FILES = [
    ["component/js-only/index.js", "module.exports = 'component';\n"],
    ["core/index.js", "module.exports = 'core';\n"],
    ["core/rule.js", "module.exports = 'rule';\n"],
    ["smart/card/index.js", "module.exports = 'smart-js';\n"],
    ["smart/card/index.scss", ".card {}\n"],
    ["smart/card/js/templates/interactive.js", "export default {};\n"],
    ["smart/card/template/default.html", "<div></div>\n"],
    ["utility/space/default/index.js", "module.exports = 'utility-js';\n"],
    ["utility/space/default/index.scss", ".space {}\n"],
];

function makeWorkspace()
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sf-build-plan-"));

    return {
        outputRoot: path.join(workspace, "output"),
        sourceRoot: path.join(workspace, "source"),
        workspace,
    };
}

function removeWorkspace(workspace)
{
    fs.rmSync(workspace, { force: true, recursive: true });
}

function writeFiles(root, files)
{
    for (const [relativePath, content] of files)
    {
        const destination = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
    }
}

function snapshotTree(root)
{
    const snapshot = [];

    function visit(directory, relativeDirectory)
    {
        const dirents = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));

        for (const dirent of dirents)
        {
            const absolutePath = path.join(directory, dirent.name);
            const relativePath = relativeDirectory === ""
                ? dirent.name
                : path.join(relativeDirectory, dirent.name);

            if (dirent.isDirectory())
            {
                snapshot.push(`directory:${relativePath}`);
                visit(absolutePath, relativePath);
            }
            else if (dirent.isSymbolicLink())
            {
                snapshot.push(`symlink:${relativePath}:${fs.readlinkSync(absolutePath)}`);
            }
            else
            {
                const digest = crypto.createHash("sha256")
                    .update(fs.readFileSync(absolutePath))
                    .digest("hex");
                snapshot.push(`file:${relativePath}:${digest}`);
            }
        }
    }

    visit(root, "");

    return snapshot;
}

function findEntry(plan, key)
{
    return plan.entries.find(entry => entry.key === key);
}

function componentTarget(overrides = {})
{
    return {
        directory: "component",
        entryPriority: ["index.js", "index.scss"],
        name: "component",
        outputPrefix: "component",
        ...overrides,
    };
}

test("build plan is stable across filesystem creation order", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, STANDARD_FILES);
        const firstPlan = createBuildPlan(workspace);

        fs.rmSync(workspace.sourceRoot, { force: true, recursive: true });
        writeFiles(workspace.sourceRoot, [...STANDARD_FILES].reverse());
        const secondPlan = createBuildPlan(workspace);

        assert.deepEqual(secondPlan, firstPlan);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("ordering uses code units and does not depend on localeCompare", () => {
    const workspace = makeWorkspace();
    const originalLocaleCompare = String.prototype.localeCompare;

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/ä/index.js", "module.exports = 'umlaut';\n"],
            ["component/z/index.js", "module.exports = 'zed';\n"],
        ]);

        String.prototype.localeCompare = () => {
            throw new Error("localeCompare must not be used for build-plan ordering");
        };

        const plan = createBuildPlan({
            ...workspace,
            targets: [componentTarget()],
        });

        assert.deepEqual(
            plan.entries.map(entry => entry.key),
            ["component/z", "component/ä"],
        );
    }
    finally
    {
        String.prototype.localeCompare = originalLocaleCompare;
        removeWorkspace(workspace.workspace);
    }
});

test("default targets select Component, Utility, Core, Rule and Smart entries", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, STANDARD_FILES);
        const plan = createBuildPlan(workspace);

        assert.equal(
            findEntry(plan, "component/js-only").input,
            path.join(plan.sourceRoot, "component/js-only/index.js"),
        );
        assert.equal(
            findEntry(plan, "utility/space/default").input,
            path.join(plan.sourceRoot, "utility/space/default/index.scss"),
        );
        assert.equal(
            findEntry(plan, "smart/card").input,
            path.join(plan.sourceRoot, "smart/card/index.scss"),
        );
        assert.equal(
            findEntry(plan, "core").input,
            path.join(plan.sourceRoot, "core/index.js"),
        );
        assert.equal(
            findEntry(plan, "rule").input,
            path.join(plan.sourceRoot, "core/rule.js"),
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("Smart templates support template and js/templates layouts", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, STANDARD_FILES);
        const plan = createBuildPlan(workspace);

        assert.deepEqual(
            plan.templates.map(template => ({
                destination: path.relative(plan.outputRoot, template.destination),
                layout: template.layout,
            })),
            [
                {
                    destination: path.join("smart", "card", "template", "default.html"),
                    layout: "template",
                },
                {
                    destination: path.join("smart", "card", "template", "interactive.js"),
                    layout: "js/templates",
                },
            ],
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("duplicate entry keys fail fast", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/card/index.js", "module.exports = {};\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget(), componentTarget()],
            }),
            /duplicate entry key: component\/card/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("duplicate Smart template destinations fail fast", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["smart/card/index.js", "module.exports = {};\n"],
            ["smart/card/js/templates/default.js", "export default 'new';\n"],
            ["smart/card/template/default.js", "export default 'legacy';\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "smart",
                    entryPriority: ["index.scss", "index.js"],
                    name: "smart",
                    outputPrefix: "smart",
                    templateLayouts: ["template", "js/templates"],
                }],
            }),
            /duplicate template destination/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("entry and template destinations cannot claim the same output path", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["core/index.js", "module.exports = 'collision';\n"],
            ["smart/card/index.scss", ".card {}\n"],
            ["smart/card/template/default.html", "<div></div>\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [
                    {
                        directory: "core",
                        fixedEntries: [{
                            file: "index.js",
                            key: "collision",
                            output: "smart/card/template/default.html",
                        }],
                        name: "core",
                        outputPrefix: "",
                    },
                    {
                        directory: "smart",
                        entryPriority: ["index.scss", "index.js"],
                        name: "smart",
                        outputPrefix: "smart",
                        templateLayouts: ["template"],
                    },
                ],
            }),
            /entry\/template destination collision/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("file destinations cannot be ancestors of planned output paths", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["core/index.js", "module.exports = 'descendant';\n"],
            ["smart/card/index.scss", ".card {}\n"],
            ["smart/card/template/default.html", "<div></div>\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [
                    {
                        directory: "core",
                        fixedEntries: [{
                            file: "index.js",
                            key: "descendant",
                            output: "smart/card/template/default.html/child",
                        }],
                        name: "core",
                        outputPrefix: "",
                    },
                    {
                        directory: "smart",
                        entryPriority: ["index.scss", "index.js"],
                        name: "smart",
                        outputPrefix: "smart",
                        templateLayouts: ["template"],
                    },
                ],
            }),
            /file destination is an ancestor/,
        );

        fs.rmSync(workspace.sourceRoot, { force: true, recursive: true });
        writeFiles(workspace.sourceRoot, [
            ["smart/card/index.scss", ".card {}\n"],
            ["smart/card/js/templates/foo/bar", "nested\n"],
            ["smart/card/template/foo", "ancestor\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "smart",
                    entryPriority: ["index.scss", "index.js"],
                    name: "smart",
                    outputPrefix: "smart",
                    templateLayouts: ["template", "js/templates"],
                }],
            }),
            /file destination is an ancestor/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("portable collision identities reject case and Unicode aliases", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["core/index.js", "module.exports = 'core';\n"],
            ["core/rule.js", "module.exports = 'rule';\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "core",
                    fixedEntries: [
                        { file: "index.js", key: "Core", output: "Core" },
                        { file: "rule.js", key: "core", output: "core" },
                    ],
                    name: "core",
                    outputPrefix: "",
                }],
            }),
            /duplicate entry key: core/,
        );

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "core",
                    fixedEntries: [
                        { file: "index.js", key: "primary", output: "É" },
                        { file: "rule.js", key: "secondary", output: "e\u0301" },
                    ],
                    name: "core",
                    outputPrefix: "",
                }],
            }),
            /duplicate entry output/,
        );

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "core",
                    fixedEntries: [
                        { file: "index.js", key: "primary", output: "Straße" },
                        { file: "rule.js", key: "secondary", output: "STRASSE" },
                    ],
                    name: "core",
                    outputPrefix: "",
                }],
            }),
            /duplicate entry output/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("missing source root fails without creating output", () => {
    const workspace = makeWorkspace();

    try
    {
        assert.throws(
            () => createBuildPlan(workspace),
            /sourceRoot does not exist/,
        );
        assert.equal(fs.existsSync(workspace.outputRoot), false);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("requested collection targets fail when no entry exists", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/README.md", "No build entry.\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget()],
            }),
            /target has no entries: component/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("requested fixed targets fail when their entry list is empty", () => {
    const workspace = makeWorkspace();

    try
    {
        fs.mkdirSync(path.join(workspace.sourceRoot, "core"), { recursive: true });

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "core",
                    fixedEntries: [],
                    name: "core",
                    outputPrefix: "",
                }],
            }),
            /fixedEntries must be a non-empty array/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("external directory symlinks are rejected", () => {
    const workspace = makeWorkspace();
    const externalRoot = path.join(workspace.workspace, "external");

    try
    {
        writeFiles(externalRoot, [
            ["index.js", "module.exports = 'external';\n"],
        ]);
        fs.mkdirSync(path.join(workspace.sourceRoot, "component"), { recursive: true });
        fs.symlinkSync(
            externalRoot,
            path.join(workspace.sourceRoot, "component/external"),
            "dir",
        );

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget()],
            }),
            /escapes .*root/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("internal directory cycles terminate with an explicit error", () => {
    const workspace = makeWorkspace();
    const componentRoot = path.join(workspace.sourceRoot, "component");

    try
    {
        fs.mkdirSync(componentRoot, { recursive: true });
        fs.symlinkSync(componentRoot, path.join(componentRoot, "loop"), "dir");

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget()],
            }),
            /directory cycle or duplicate real path/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("dangling or cyclic source symlinks cannot masquerade as absent paths", () => {
    const workspace = makeWorkspace();
    const componentRoot = path.join(workspace.sourceRoot, "component/card");
    const preferredEntry = path.join(componentRoot, "index.scss");
    const smartRoot = path.join(workspace.sourceRoot, "smart/card");
    const templateRoot = path.join(smartRoot, "template");

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/card/index.js", "module.exports = 'fallback';\n"],
            ["smart/card/index.scss", ".card {}\n"],
        ]);
        fs.symlinkSync(preferredEntry, preferredEntry, "file");

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget({
                    entryPriority: ["index.scss", "index.js"],
                })],
            }),
            /entry .* does not exist/,
        );

        fs.symlinkSync(templateRoot, templateRoot, "dir");

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "smart",
                    entryPriority: ["index.scss", "index.js"],
                    name: "smart",
                    outputPrefix: "smart",
                    templateLayouts: ["template"],
                }],
            }),
            /template directory .* does not exist/,
        );

        fs.unlinkSync(templateRoot);
        fs.symlinkSync(
            path.join(workspace.workspace, "missing-template"),
            templateRoot,
            "dir",
        );

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [{
                    directory: "smart",
                    entryPriority: ["index.scss", "index.js"],
                    name: "smart",
                    outputPrefix: "smart",
                    templateLayouts: ["template"],
                }],
            }),
            /template directory .* does not exist/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("output paths cannot escape outputRoot or live under sourceRoot", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/card/index.js", "module.exports = {};\n"],
        ]);

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget({ outputPrefix: "../escape" })],
            }),
            /escapes .*root/,
        );
        assert.throws(
            () => createBuildPlan({
                ...workspace,
                outputRoot: path.join(workspace.sourceRoot, "generated"),
                targets: [componentTarget()],
            }),
            /must not overlap/,
        );
        assert.throws(
            () => createBuildPlan({
                ...workspace,
                outputRoot: workspace.workspace,
                targets: [componentTarget()],
            }),
            /must not overlap/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("output symlinks cannot escape or alias planned destinations", () => {
    const workspace = makeWorkspace();
    const externalOutput = path.join(workspace.workspace, "external-output");

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/card/index.js", "module.exports = {};\n"],
        ]);
        fs.mkdirSync(workspace.outputRoot, { recursive: true });
        fs.mkdirSync(externalOutput, { recursive: true });
        fs.symlinkSync(
            externalOutput,
            path.join(workspace.outputRoot, "component"),
            "dir",
        );

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget()],
            }),
            /output symlink/,
        );

        fs.rmSync(path.join(workspace.outputRoot, "component"));
        fs.mkdirSync(path.join(workspace.outputRoot, "actual"), { recursive: true });
        fs.symlinkSync(
            path.join(workspace.outputRoot, "actual"),
            path.join(workspace.outputRoot, "component"),
            "dir",
        );

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget()],
            }),
            /output symlink/,
        );

        fs.rmSync(workspace.outputRoot, { force: true, recursive: true });
        fs.symlinkSync(workspace.outputRoot, workspace.outputRoot, "dir");

        assert.throws(
            () => createBuildPlan({
                ...workspace,
                targets: [componentTarget()],
            }),
            /cannot resolve existing ancestor/,
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("the declared output root authority is canonicalized before planning", () => {
    const workspace = makeWorkspace();
    const externalOutput = path.join(workspace.workspace, "external-output");
    const outputAlias = path.join(workspace.workspace, "output-alias");

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["component/card/index.js", "module.exports = {};\n"],
        ]);
        fs.mkdirSync(externalOutput, { recursive: true });
        fs.symlinkSync(externalOutput, outputAlias, "dir");

        const plan = createBuildPlan({
            ...workspace,
            outputRoot: path.join(outputAlias, "build"),
            targets: [componentTarget()],
        });

        assert.equal(
            plan.outputRoot,
            path.join(fs.realpathSync(externalOutput), "build"),
        );
        assert.equal(
            plan.entries[0].outputDirectory,
            path.join(plan.outputRoot, "component/card"),
        );
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("existing regular template destinations remain valid and unchanged", () => {
    const workspace = makeWorkspace();
    const existingOutput = "smart/card/template/default.html";

    try
    {
        writeFiles(workspace.sourceRoot, [
            ["smart/card/index.scss", ".card {}\n"],
            ["smart/card/template/default.html", "<div>new</div>\n"],
        ]);
        writeFiles(workspace.outputRoot, [
            [existingOutput, "<div>existing</div>\n"],
        ]);
        const before = snapshotTree(workspace.outputRoot);
        const plan = createBuildPlan({
            ...workspace,
            targets: [{
                directory: "smart",
                entryPriority: ["index.scss", "index.js"],
                name: "smart",
                outputPrefix: "smart",
                templateLayouts: ["template"],
            }],
        });
        const after = snapshotTree(workspace.outputRoot);

        assert.equal(
            plan.templates[0].destination,
            path.join(plan.outputRoot, existingOutput),
        );
        assert.deepEqual(after, before);
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});

test("planning does not mutate source or create output", () => {
    const workspace = makeWorkspace();

    try
    {
        writeFiles(workspace.sourceRoot, STANDARD_FILES);
        const before = snapshotTree(workspace.sourceRoot);
        const plan = createBuildPlan(workspace);
        const after = snapshotTree(workspace.sourceRoot);

        assert.deepEqual(after, before);
        assert.equal(fs.existsSync(workspace.outputRoot), false);

        for (const entry of plan.entries)
        {
            assert.equal(
                path.relative(plan.outputRoot, entry.outputDirectory)
                    .startsWith(`..${path.sep}`),
                false,
            );
        }

        for (const template of plan.templates)
        {
            assert.equal(
                path.relative(plan.outputRoot, template.destination)
                    .startsWith(`..${path.sep}`),
                false,
            );
        }
    }
    finally
    {
        removeWorkspace(workspace.workspace);
    }
});
