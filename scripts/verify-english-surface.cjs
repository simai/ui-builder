#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const INCLUDED_EXTENSIONS = new Set([
    ".cjs",
    ".js",
    ".json",
    ".md",
    ".yaml",
    ".yml",
]);
const INCLUDED_FILES = new Set([".env.example"]);
const EXCLUDED_DIRECTORIES = new Set([
    ".git",
    "node_modules",
    "output",
    "source",
]);
const CYRILLIC = /[\u0400-\u04ff]/u;

function filesUnder(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap(entry => {
            if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name))
            {
                return [];
            }

            const absolute = path.join(directory, entry.name);

            if (entry.isDirectory())
            {
                return filesUnder(absolute);
            }

            if (!entry.isFile())
            {
                return [];
            }

            return INCLUDED_FILES.has(entry.name)
                || INCLUDED_EXTENSIONS.has(path.extname(entry.name))
                ? [absolute]
                : [];
        });
}

function cyrillicLocations(filePath)
{
    return fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/u)
        .flatMap((line, index) => CYRILLIC.test(line)
            ? [`${path.relative(ROOT, filePath)}:${index + 1}`]
            : []);
}

const failures = filesUnder(ROOT).flatMap(cyrillicLocations);
const gitDirectory = path.join(ROOT, ".git");

if (fs.existsSync(gitDirectory))
{
    const history = execFileSync(
        "git",
        ["log", "--format=%H%x09%s%x09%b"],
        { cwd: ROOT, encoding: "utf8" },
    );

    for (const line of history.split(/\r?\n/u))
    {
        if (CYRILLIC.test(line))
        {
            failures.push(`git-history:${line.slice(0, 40)}`);
        }
    }
}

if (failures.length > 0)
{
    process.stderr.write(
        "English-only repository surface check failed:\n"
        + `${failures.map(item => `- ${item}`).join("\n")}\n`,
    );
    process.exitCode = 1;
}
else
{
    process.stdout.write("English-only repository surface check: PASS\n");
}
