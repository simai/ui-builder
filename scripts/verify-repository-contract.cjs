#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ACCEPTED_LOCK_SHA256 =
    "fa54d7fe2f590e8dadaac0bd0e5485184e11317393f41c75c8ebb7c3d04e755c";

function sha256(filePath)
{
    return crypto.createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
}

function check(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

const packageJson = JSON.parse(fs.readFileSync(
    path.join(ROOT, "package.json"),
    "utf8",
));
const lockSha256 = sha256(path.join(ROOT, "yarn.lock"));

check(packageJson.name === "@simai/ui-builder", "unexpected package name");
check(packageJson.private === true, "builder package must remain private");
check(packageJson.packageManager === "yarn@1.22.22", "unexpected Yarn runtime");
check(packageJson.engines.node === ">=20.19.0", "unexpected Node contract");
check(packageJson.devDependencies.webpack === "5.108.4", "unexpected Webpack");
check(lockSha256 === ACCEPTED_LOCK_SHA256, "accepted frozen lockfile drifted");
check(
    packageJson.scripts["check:english"]
        === "node scripts/verify-english-surface.cjs",
    "English surface check is missing",
);

for (const script of [
    "full",
    "core",
    "utility",
    "comp",
    "plugin",
    "dev",
    "modal",
    "outline",
    "divider",
    "editorjs",
])
{
    check(typeof packageJson.scripts[script] === "string", `missing ${script} script`);
}

for (const removed of ["postcss-selector-parser", "style-loader", "yarn", "zlib"])
{
    check(
        !Object.prototype.hasOwnProperty.call(
            packageJson.devDependencies,
            removed,
        )
        && !Object.prototype.hasOwnProperty.call(
            packageJson.dependencies || {},
            removed,
        ),
        `unused direct dependency returned: ${removed}`,
    );
}

for (const configuration of [
    "core.webpack.js",
    "core.min.webpack.js",
    "component.webpack.js",
    "component.min.webpack.js",
    "utility.webpack.js",
    "utility.min.webpack.js",
])
{
    check(
        fs.existsSync(path.join(ROOT, configuration)),
        `full build configuration is missing: ${configuration}`,
    );
}

const fullBuildSource = fs.readFileSync(path.join(ROOT, "full.build.js"), "utf8");

check(!/webpack\.core|webpack\.plugin/.test(fullBuildSource),
    "full build still references removed legacy configurations");

const report = {
    accepted_builder_revision: "d4d151cce5f0955b1d838e8127ba7555df98d05c",
    lock_sha256: lockSha256,
    node: packageJson.engines.node,
    package_manager: packageJson.packageManager,
    schema_version: 1,
    status: "PASS",
    webpack: packageJson.devDependencies.webpack,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
