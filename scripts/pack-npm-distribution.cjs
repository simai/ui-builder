#!/usr/bin/env node
"use strict";

// Usage: node scripts/pack-npm-distribution.cjs --ui <simai/ui checkout> --release <commit>
//          --out <empty or new directory> [--name @simai/ui]
//
// Lays the npm package of one Framework release (owner, 2026-10-19,
// simai/ui-source#5). jsDelivr's /gh/ proxy serves a repository of at most
// 50 MB, and simai/ui at e7701fef3733 was 52.6 MB: uncached files of the
// documented CDN form answered 403 or 404 for first-time readers. A package on
// npm is served by its own size, not the repository's, and it carries only
// what a page asks for:
//
//   - distr/ at the release commit, read from git (never a working tree);
//   - the minified form of every component, utility and Smart script and sheet
//     that has one -- the Loader asks for it and falls back to the other form
//     by itself; Core whole, in both forms: the documentation links
//     core/js/core.js and core/css/core.css by name, and the readable entry
//     loads its readable chunks (core-rules.js, core-loader.js, ...);
//   - no .gz twins: a CDN compresses what it serves; they exist for a site
//     that serves distr/ from its own disk.
//
// The release is still the commit (ui-<12 hex>); the package version is
// derived from the commit's time, 5.<yyyymmdd>.<hhmm> in UTC, so it rises with
// every release and is the same whoever packs it. package.json names the
// commit, and package-manifest.json lists every file with its SHA-256.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ui = option("--ui");
const release = option("--release");
const out = option("--out");
const name = option("--name", "@simai/ui");

if (!ui || !release || !out)
{
    console.error("Usage: node scripts/pack-npm-distribution.cjs --ui <simai/ui> --release <commit> --out <dir> [--name @simai/ui]");
    process.exit(2);
}

const git = (...command) => execFileSync("git", ["-C", ui, ...command], { maxBuffer: 1 << 30 });
const commit = git("rev-parse", "--verify", `${release}^{commit}`).toString().trim();
const id = `ui-${commit.slice(0, 12)}`;
const when = new Date(Number(git("show", "-s", "--format=%ct", commit).toString().trim()) * 1000);
const pad = (value) => String(value).padStart(2, "0");
const version = `5.${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}.${Number(`${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}`)}`;

if (fs.existsSync(out) && fs.readdirSync(out).length)
{
    throw new Error(`${out} is not empty`);
}

fs.mkdirSync(out, { recursive: true });
const listed = git("ls-tree", "-r", "--name-only", commit, "distr").toString().split("\n").filter(Boolean);
const present = new Set(listed);

const kept = listed.filter((file) => {
    if (file.endsWith(".gz")) return false;
    const match = file.match(/^(.*)\.(js|css)$/u);
    if (!match || match[1].endsWith(".min") || file.startsWith("distr/core/")) return true;
    return !present.has(`${match[1]}.min.${match[2]}`);
});

const manifest = {};
for (const file of kept)
{
    const bytes = git("show", `${commit}:${file}`);
    const target = path.join(out, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    manifest[file] = `sha256-${crypto.createHash("sha256").update(bytes).digest("base64")}`;
}

for (const file of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"])
{
    if (present.has(file) || git("ls-tree", "--name-only", commit, file).toString().trim())
    {
        fs.writeFileSync(path.join(out, file), git("show", `${commit}:${file}`));
    }
}

const pkg = {
    name,
    version,
    description: `SIMAI Framework distribution, release ${id}: Core, the Loader, components, utilities and Smart Components, ready to serve from distr/.`,
    license: "Apache-2.0",
    homepage: "https://simai.github.io/ui-doc/",
    repository: { type: "git", url: "git+https://github.com/simai/ui.git" },
    files: ["distr", "package-manifest.json", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md", "README.md"],
    simai: { release: id, commit },
};
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(path.join(out, "package-manifest.json"), `${JSON.stringify({ release: id, commit, version, files: manifest }, null, 2)}\n`);
fs.writeFileSync(path.join(out, "README.md"), [
    `# ${name}`,
    "",
    `SIMAI Framework, release \`${id}\` (commit ${commit} of [simai/ui](https://github.com/simai/ui)).`,
    "",
    "```html",
    `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/${name}@${version}/distr/core/css/core.css">`,
    `<script>window.sfPath = 'https://cdn.jsdelivr.net/npm/${name}@${version}/distr/';</script>`,
    `<script src="https://cdn.jsdelivr.net/npm/${name}@${version}/distr/core/js/core.js"></script>`,
    "```",
    "",
    "Components, utilities and Smart Components ship in their minified form (the Loader asks for it); Core in both forms. Documentation: https://simai.github.io/ui-doc/",
    "",
].join("\n"));

const bytes = kept.reduce((sum, file) => sum + fs.statSync(path.join(out, file)).size, 0);
console.log(JSON.stringify({ name, version, release: id, files: kept.length, distrBytes: bytes, out }));
