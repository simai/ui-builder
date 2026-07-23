"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TARGETS = Object.freeze([
    Object.freeze({
        name: "component",
        directory: "component",
        outputPrefix: "component",
        entryPriority: Object.freeze(["index.js", "index.scss"]),
    }),
    Object.freeze({
        name: "core",
        directory: "core",
        outputPrefix: "",
        fixedEntries: Object.freeze([
            Object.freeze({ key: "core", file: "index.js", output: "core" }),
            Object.freeze({ key: "rule", file: "rule.js", output: "rule" }),
        ]),
    }),
    Object.freeze({
        name: "smart",
        directory: "smart",
        outputPrefix: "smart",
        entryPriority: Object.freeze(["index.scss", "index.js"]),
        templateLayouts: Object.freeze(["template", "js/templates"]),
    }),
    Object.freeze({
        name: "utility",
        directory: "utility",
        outputPrefix: "utility",
        entryPriority: Object.freeze(["index.scss", "index.js"]),
    }),
]);

function isWithin(root, candidate)
{
    const relative = path.relative(root, candidate);

    return relative === ""
        || (!relative.startsWith(`..${path.sep}`)
            && relative !== ".."
            && !path.isAbsolute(relative));
}

function assertAbsolutePath(value, label)
{
    if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value))
    {
        throw new TypeError(`${label} must be a non-empty absolute path`);
    }
}

function assertWithin(root, candidate, label)
{
    if (!isWithin(root, candidate))
    {
        throw new Error(`${label} escapes declared root: ${candidate}`);
    }
}

function canonicalDirectory(directory, label)
{
    assertAbsolutePath(directory, label);

    let realDirectory;

    try
    {
        realDirectory = fs.realpathSync(directory);
    }
    catch
    {
        throw new Error(`${label} does not exist: ${directory}`);
    }

    if (!fs.statSync(realDirectory).isDirectory())
    {
        throw new Error(`${label} is not a directory: ${directory}`);
    }

    return realDirectory;
}

function canonicalFuturePath(candidate, label)
{
    assertAbsolutePath(candidate, label);

    const missingSegments = [];
    let cursor = path.normalize(candidate);

    while (true)
    {
        try
        {
            fs.lstatSync(cursor);
            break;
        }
        catch (error)
        {
            if (!error || (error.code !== "ENOENT" && error.code !== "ENOTDIR"))
            {
                throw new Error(`${label} cannot inspect existing ancestor: ${cursor}`);
            }
        }

        const parent = path.dirname(cursor);
        if (parent === cursor)
        {
            throw new Error(`${label} has no existing ancestor: ${candidate}`);
        }

        missingSegments.unshift(path.basename(cursor));
        cursor = parent;
    }

    let existingRoot;

    try
    {
        existingRoot = fs.realpathSync(cursor);
    }
    catch
    {
        throw new Error(`${label} cannot resolve existing ancestor: ${cursor}`);
    }

    if (!fs.statSync(existingRoot).isDirectory())
    {
        throw new Error(`${label} existing ancestor is not a directory: ${cursor}`);
    }

    return path.join(existingRoot, ...missingSegments);
}

function assertSafeOutputPath(outputRoot, outputPath, label, finalType)
{
    assertWithin(outputRoot, outputPath, label);

    const relativePath = path.relative(outputRoot, outputPath);
    const segments = relativePath.split(path.sep).filter(Boolean);
    let cursor = outputRoot;

    if (segments.length === 0 && finalType === "file")
    {
        throw new Error(`${label} output destination is not a file: ${outputPath}`);
    }

    for (const [index, segment] of segments.entries())
    {
        cursor = path.join(cursor, segment);

        let stat;

        try
        {
            stat = fs.lstatSync(cursor);
        }
        catch (error)
        {
            if (error && error.code === "ENOENT")
            {
                break;
            }

            throw new Error(`${label} cannot inspect output path: ${cursor}`);
        }

        if (stat.isSymbolicLink())
        {
            throw new Error(`${label} uses an output symlink: ${cursor}`);
        }

        const isFinal = index === segments.length - 1;

        if (isFinal && finalType === "file")
        {
            if (!stat.isFile())
            {
                throw new Error(`${label} output destination is not a file: ${cursor}`);
            }

            const effectiveFile = fs.realpathSync(cursor);
            assertWithin(outputRoot, effectiveFile, label);

            return;
        }

        if (!stat.isDirectory())
        {
            throw new Error(`${label} output ancestor is not a directory: ${cursor}`);
        }
    }

    const effectivePath = canonicalFuturePath(outputPath, label);
    assertWithin(outputRoot, effectivePath, label);
}

function inspectPath(candidate, sourceRoot, label)
{
    let realCandidate;

    try
    {
        realCandidate = fs.realpathSync(candidate);
    }
    catch
    {
        throw new Error(`${label} does not exist: ${candidate}`);
    }

    assertWithin(sourceRoot, realCandidate, label);

    const stat = fs.statSync(realCandidate);

    return {
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        realPath: realCandidate,
    };
}

function pathExistsLexically(candidate, label)
{
    try
    {
        fs.lstatSync(candidate);

        return true;
    }
    catch (error)
    {
        if (error && error.code === "ENOENT")
        {
            return false;
        }

        throw new Error(`${label} cannot be inspected: ${candidate}`);
    }
}

function toPosix(relativePath)
{
    return relativePath.split(path.sep).join("/");
}

function compareCodeUnits(left, right)
{
    if (left < right)
    {
        return -1;
    }

    if (left > right)
    {
        return 1;
    }

    return 0;
}

function portableIdentity(value)
{
    return value.normalize("NFKC")
        .toUpperCase()
        .toLowerCase()
        .normalize("NFC");
}

function portablePathParts(value)
{
    const normalized = path.normalize(value);
    const root = path.parse(normalized).root;
    const relative = path.relative(root, normalized);
    const parts = relative === "" ? [] : relative.split(path.sep);

    return [portableIdentity(root), ...parts.map(portableIdentity)];
}

function samePortablePath(left, right)
{
    return left.length === right.length
        && left.every((part, index) => part === right[index]);
}

function isPortableAncestor(ancestor, candidate)
{
    return ancestor.length < candidate.length
        && ancestor.every((part, index) => part === candidate[index]);
}

function normalizeRelativePath(value, label)
{
    if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value))
    {
        throw new TypeError(`${label} must be a non-empty relative path`);
    }

    const normalized = path.normalize(value);

    if (normalized === ".." || normalized.startsWith(`..${path.sep}`))
    {
        throw new Error(`${label} escapes its declared root: ${value}`);
    }

    return normalized;
}

function normalizeTargets(targets)
{
    if (!Array.isArray(targets) || targets.length === 0)
    {
        throw new TypeError("targets must be a non-empty array");
    }

    return targets.map((target, targetIndex) => {
        if (!target || typeof target !== "object")
        {
            throw new TypeError(`targets[${targetIndex}] must be an object`);
        }

        if (typeof target.name !== "string" || target.name.length === 0)
        {
            throw new TypeError(`targets[${targetIndex}].name must be a non-empty string`);
        }

        const normalized = {
            directory: normalizeRelativePath(
                target.directory,
                `targets[${targetIndex}].directory`,
            ),
            entryPriority: undefined,
            fixedEntries: undefined,
            name: target.name,
            outputPrefix: target.outputPrefix === ""
                ? ""
                : normalizeRelativePath(
                    target.outputPrefix || target.name,
                    `targets[${targetIndex}].outputPrefix`,
                ),
            templateLayouts: (target.templateLayouts || []).map((layout, layoutIndex) =>
                normalizeRelativePath(
                    layout,
                    `targets[${targetIndex}].templateLayouts[${layoutIndex}]`,
                )),
        };

        if (Array.isArray(target.fixedEntries))
        {
            if (target.fixedEntries.length === 0)
            {
                throw new TypeError(
                    `targets[${targetIndex}].fixedEntries must be a non-empty array`,
                );
            }

            normalized.fixedEntries = target.fixedEntries.map((entry, entryIndex) => {
                if (!entry || typeof entry !== "object")
                {
                    throw new TypeError(
                        `targets[${targetIndex}].fixedEntries[${entryIndex}] must be an object`,
                    );
                }

                if (typeof entry.key !== "string" || entry.key.length === 0)
                {
                    throw new TypeError(
                        `targets[${targetIndex}].fixedEntries[${entryIndex}].key must be a non-empty string`,
                    );
                }

                return {
                    file: normalizeRelativePath(
                        entry.file,
                        `targets[${targetIndex}].fixedEntries[${entryIndex}].file`,
                    ),
                    key: entry.key,
                    output: normalizeRelativePath(
                        entry.output || entry.key,
                        `targets[${targetIndex}].fixedEntries[${entryIndex}].output`,
                    ),
                };
            });
        }
        else
        {
            if (!Array.isArray(target.entryPriority) || target.entryPriority.length === 0)
            {
                throw new TypeError(
                    `targets[${targetIndex}].entryPriority must be a non-empty array`,
                );
            }

            normalized.entryPriority = target.entryPriority.map((entry, entryIndex) =>
                normalizeRelativePath(
                    entry,
                    `targets[${targetIndex}].entryPriority[${entryIndex}]`,
                ));
        }

        return normalized;
    }).sort((left, right) => {
        const byName = compareCodeUnits(left.name, right.name);

        return byName || compareCodeUnits(left.directory, right.directory);
    });
}

function resolveOutputPath(outputRoot, segments, label, finalType = "directory")
{
    const outputPath = path.resolve(outputRoot, ...segments);
    assertSafeOutputPath(outputRoot, outputPath, label, finalType);

    return outputPath;
}

function sortedDirectoryEntries(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => compareCodeUnits(left.name, right.name));
}

function selectEntry(directory, entryPriority, sourceRoot)
{
    for (const entryName of entryPriority)
    {
        const candidate = path.join(directory, entryName);

        if (!pathExistsLexically(candidate, `entry candidate ${candidate}`))
        {
            continue;
        }

        const inspected = inspectPath(candidate, sourceRoot, `entry ${candidate}`);

        if (!inspected.isFile)
        {
            throw new Error(`entry is not a file: ${candidate}`);
        }

        return inspected.realPath;
    }

    return null;
}

function collectCollectionEntries(target, targetRoot, sourceRoot)
{
    const entries = [];
    const visitedDirectories = new Set();

    function visit(directory, relativeDirectory)
    {
        const inspected = inspectPath(directory, sourceRoot, `directory ${directory}`);

        if (!inspected.isDirectory)
        {
            throw new Error(`collection path is not a directory: ${directory}`);
        }

        if (visitedDirectories.has(inspected.realPath))
        {
            throw new Error(`directory cycle or duplicate real path: ${directory}`);
        }

        visitedDirectories.add(inspected.realPath);

        const selectedEntry = selectEntry(directory, target.entryPriority, sourceRoot);

        if (selectedEntry)
        {
            if (relativeDirectory === "")
            {
                throw new Error(`collection root cannot be an entry: ${directory}`);
            }

            entries.push({
                directory,
                input: selectedEntry,
                relativeDirectory,
            });

            return;
        }

        for (const dirent of sortedDirectoryEntries(directory))
        {
            const child = path.join(directory, dirent.name);
            const childInspection = inspectPath(child, sourceRoot, `collection child ${child}`);

            if (!childInspection.isDirectory)
            {
                continue;
            }

            const childRelative = relativeDirectory === ""
                ? dirent.name
                : path.join(relativeDirectory, dirent.name);

            visit(child, childRelative);
        }
    }

    visit(targetRoot, "");

    return entries;
}

function collectFiles(directory, sourceRoot)
{
    const files = [];
    const visitedDirectories = new Set();

    function visit(currentDirectory, relativeDirectory)
    {
        const inspected = inspectPath(
            currentDirectory,
            sourceRoot,
            `template directory ${currentDirectory}`,
        );

        if (!inspected.isDirectory)
        {
            throw new Error(`template path is not a directory: ${currentDirectory}`);
        }

        if (visitedDirectories.has(inspected.realPath))
        {
            throw new Error(`template directory cycle or duplicate real path: ${currentDirectory}`);
        }

        visitedDirectories.add(inspected.realPath);

        for (const dirent of sortedDirectoryEntries(currentDirectory))
        {
            const child = path.join(currentDirectory, dirent.name);
            const childInspection = inspectPath(child, sourceRoot, `template path ${child}`);
            const childRelative = relativeDirectory === ""
                ? dirent.name
                : path.join(relativeDirectory, dirent.name);

            if (childInspection.isDirectory)
            {
                visit(child, childRelative);
            }
            else if (childInspection.isFile)
            {
                files.push({
                    relativePath: childRelative,
                    source: childInspection.realPath,
                });
            }
        }
    }

    visit(directory, "");

    return files;
}

function createBuildPlan(options)
{
    if (!options || typeof options !== "object")
    {
        throw new TypeError("options must be an object");
    }

    const sourceRoot = canonicalDirectory(options.sourceRoot, "sourceRoot");
    // The declared root itself is the authority anchor and is canonicalized.
    // Symlinks below that anchor are rejected for every planned destination.
    const outputRoot = canonicalFuturePath(options.outputRoot, "outputRoot");

    if (isWithin(sourceRoot, outputRoot) || isWithin(outputRoot, sourceRoot))
    {
        throw new Error("sourceRoot and outputRoot must not overlap");
    }

    const targets = normalizeTargets(options.targets || DEFAULT_TARGETS);
    const entries = [];
    const templates = [];
    const seenEntryKeys = new Set();
    const destinationClaims = [];

    function claimDestination(destination, kind)
    {
        const parts = portablePathParts(destination);

        for (const existing of destinationClaims)
        {
            if (samePortablePath(existing.parts, parts))
            {
                if (existing.kind !== kind)
                {
                    throw new Error(
                        `entry/template destination collision: ${destination}`,
                    );
                }

                if (kind === "entry")
                {
                    throw new Error(`duplicate entry output: ${destination}`);
                }

                throw new Error(`duplicate template destination: ${destination}`);
            }

            if (existing.kind === "template"
                && isPortableAncestor(existing.parts, parts))
            {
                throw new Error(
                    `file destination is an ancestor of another destination: ${existing.path}`,
                );
            }

            if (kind === "template" && isPortableAncestor(parts, existing.parts))
            {
                throw new Error(
                    `file destination is an ancestor of another destination: ${destination}`,
                );
            }
        }

        destinationClaims.push({
            kind,
            parts,
            path: destination,
        });
    }

    function addEntry(entry)
    {
        const keyIdentity = portableIdentity(entry.key);

        if (seenEntryKeys.has(keyIdentity))
        {
            throw new Error(`duplicate entry key: ${entry.key}`);
        }

        claimDestination(entry.outputDirectory, "entry");
        seenEntryKeys.add(keyIdentity);
        entries.push(entry);
    }

    function addTemplate(template)
    {
        claimDestination(template.destination, "template");
        templates.push(template);
    }

    for (const target of targets)
    {
        const targetPath = path.join(sourceRoot, target.directory);
        const targetInspection = inspectPath(
            targetPath,
            sourceRoot,
            `target ${target.name}`,
        );

        if (!targetInspection.isDirectory)
        {
            throw new Error(`target is not a directory: ${targetPath}`);
        }

        if (target.fixedEntries)
        {
            for (const fixedEntry of target.fixedEntries)
            {
                const input = path.join(targetPath, fixedEntry.file);
                const inputInspection = inspectPath(
                    input,
                    sourceRoot,
                    `fixed entry ${fixedEntry.key}`,
                );

                if (!inputInspection.isFile)
                {
                    throw new Error(`fixed entry is not a file: ${input}`);
                }

                addEntry({
                    input: inputInspection.realPath,
                    key: fixedEntry.key,
                    outputDirectory: resolveOutputPath(
                        outputRoot,
                        [target.outputPrefix, fixedEntry.output].filter(Boolean),
                        `fixed entry output ${fixedEntry.key}`,
                    ),
                    target: target.name,
                });
            }

            continue;
        }

        const collectionEntries = collectCollectionEntries(
            target,
            targetPath,
            sourceRoot,
        );

        if (collectionEntries.length === 0)
        {
            throw new Error(`target has no entries: ${target.name}`);
        }

        for (const collectionEntry of collectionEntries)
        {
            const relativePosix = toPosix(collectionEntry.relativeDirectory);
            const key = `${target.name}/${relativePosix}`;
            const outputSegments = [
                target.outputPrefix,
                collectionEntry.relativeDirectory,
            ].filter(Boolean);

            addEntry({
                input: collectionEntry.input,
                key,
                outputDirectory: resolveOutputPath(
                    outputRoot,
                    outputSegments,
                    `entry output ${key}`,
                ),
                target: target.name,
            });

            for (const layout of target.templateLayouts)
            {
                const templateRoot = path.join(collectionEntry.directory, layout);

                if (!pathExistsLexically(
                    templateRoot,
                    `template layout ${templateRoot}`,
                ))
                {
                    continue;
                }

                for (const templateFile of collectFiles(templateRoot, sourceRoot))
                {
                    const destination = resolveOutputPath(
                        outputRoot,
                        [
                            target.outputPrefix,
                            collectionEntry.relativeDirectory,
                            "template",
                            templateFile.relativePath,
                        ].filter(Boolean),
                        `template output ${key}`,
                        "file",
                    );

                    addTemplate({
                        component: relativePosix,
                        destination,
                        layout: toPosix(layout),
                        source: templateFile.source,
                        target: target.name,
                    });
                }
            }
        }
    }

    entries.sort((left, right) =>
        compareCodeUnits(left.key, right.key)
        || compareCodeUnits(left.input, right.input));
    templates.sort((left, right) =>
        compareCodeUnits(left.destination, right.destination)
        || compareCodeUnits(left.source, right.source));

    return {
        entries,
        outputRoot,
        schemaVersion: 1,
        sourceRoot,
        templates,
    };
}

module.exports = {
    DEFAULT_TARGETS,
    createBuildPlan,
};
