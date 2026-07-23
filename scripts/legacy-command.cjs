"use strict";

const command = process.argv[2];

if (command === "plugin")
{
    process.stderr.write(
        "The legacy 'plugin' command now builds Component. "
        + "Use 'yarn build:component' in new automation.\n",
    );
    const result = require("node:child_process").spawnSync(
        process.platform === "win32" ? "yarn.cmd" : "yarn",
        ["build:component"],
        { stdio: "inherit" },
    );
    process.exitCode = typeof result.status === "number" ? result.status : 1;
}
else if (command === "modal")
{
    process.stderr.write(
        "The legacy 'modal' target was not present in the accepted builder "
        + "source and cannot be built. Use a product runner or a supported "
        + "build:* command.\n",
    );
    process.exitCode = 2;
}
else
{
    process.stderr.write(`Unknown legacy command: ${String(command)}\n`);
    process.exitCode = 2;
}
