"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ARGUMENT_NAMES = Object.freeze([
    "packageRoot",
    "runtimeRoot",
    "diagnosticsPath",
]);
const YARN_VERSION = "1.22.22";

function resolveNpmCli()
{
    const explicit = process.env.npm_execpath;
    if (explicit && path.isAbsolute(explicit) && fs.existsSync(explicit))
    {
        return fs.realpathSync(explicit);
    }

    const executableName = process.platform === "win32" ? "npm.cmd" : "npm";
    for (const directory of (process.env.PATH || "").split(path.delimiter))
    {
        if (!directory) continue;
        const candidate = path.join(directory, executableName);
        if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    }

    throw new Error("npm CLI could not be resolved from npm_execpath or PATH");
}

function fail(code, message, details)
{
    process.stderr.write(`${JSON.stringify({
        code,
        details,
        message,
        phase: "dependency-runtime",
        schemaVersion: 1,
        status: 2,
    })}\n`);
    process.exitCode = 2;
}

function validatedArguments(received)
{
    if (received.length !== ARGUMENT_NAMES.length)
    {
        fail(
            "INVALID_ARGUMENT_COUNT",
            "expected exactly three path arguments",
            { actual: received.length, expected: ARGUMENT_NAMES.length },
        );
        return null;
    }

    const invalidArguments = received
        .map((candidate, index) => ({ candidate, index, name: ARGUMENT_NAMES[index] }))
        .filter(({ candidate }) => !candidate || !path.isAbsolute(candidate))
        .map(({ index, name }) => ({ index, name }));

    if (invalidArguments.length > 0)
    {
        fail(
            "ARGUMENT_NOT_ABSOLUTE",
            "all three path arguments must be non-empty absolute paths",
            { invalidArguments },
        );
        return null;
    }

    return Object.fromEntries(
        ARGUMENT_NAMES.map((name, index) => [name, received[index]]),
    );
}

const usage = validatedArguments(process.argv.slice(2));

if (usage)
{
    const { diagnosticsPath, packageRoot, runtimeRoot } = usage;
    const packagePath = path.join(packageRoot, "package.json");
    const lockPath = path.join(packageRoot, "yarn.lock");

    if (!fs.existsSync(packagePath) || !fs.existsSync(lockPath))
    {
        fail(
            "FROZEN_INPUT_MISSING",
            "packageRoot must contain package.json and yarn.lock",
            {
                packageJson: fs.existsSync(packagePath),
                yarnLock: fs.existsSync(lockPath),
            },
        );
    }
    else if (fs.existsSync(runtimeRoot))
    {
        fail(
            "RUNTIME_ROOT_EXISTS",
            "runtimeRoot must not already exist",
            { runtimeRoot },
        );
    }
    else
    {
        fs.mkdirSync(runtimeRoot, { recursive: true });
        fs.copyFileSync(packagePath, path.join(runtimeRoot, "package.json"));
        fs.copyFileSync(lockPath, path.join(runtimeRoot, "yarn.lock"));

        let npmCli;
        try
        {
            npmCli = resolveNpmCli();
        }
        catch (error)
        {
            fail(
                "NPM_CLI_MISSING",
                error && error.message ? error.message : String(error),
                {},
            );
            return;
        }
        const command = process.execPath;
        const result = spawnSync(command, [npmCli,
            "exec",
            "--yes",
            `--package=yarn@${YARN_VERSION}`,
            "--",
            "yarn",
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--non-interactive",
        ], {
            cwd: runtimeRoot,
            encoding: "utf8",
        });
        const diagnostics = {
            command,
            npmCli,
            lockfile: "yarn.lock",
            runtimeRoot,
            schemaVersion: 1,
            signal: result.signal,
            status: result.status === 0 ? 0 : 1,
            stderr: result.stderr,
            stdout: result.stdout,
            yarnVersion: YARN_VERSION,
        };

        fs.writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
        process.exitCode = diagnostics.status;
    }
}
