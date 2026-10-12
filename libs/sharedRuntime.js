"use strict";

// The shared Smart runtime (ui-source src/core/js/runtime.js): the modules every
// Smart element is built on are loaded once per page by Core, and the Smart and
// package bundles are built without their own copies (2026-10-13). Each Smart
// bundle carried lit, smart-base and page-language itself -- about 50 KB
// minified, parsed again for every element on the page.
//
// An import of one of these modules from a product source file becomes an
// external that waits for the runtime: `SF.runtimeModule(id)`. The ids are the
// runtime's keys; keep the two lists the same.

const path = require("node:path");

const BARE_MODULES = Object.freeze([
    "lit",
    "lit/directive.js",
    "lit/directive-helpers.js",
    "lit/directives/ref.js",
    "lit/directives/keyed.js",
    "lit/directives/unsafe-html.js",
]);

const CORE_MODULES = Object.freeze({
    "smart-base": "core/js/smart-base",
    "page-language": "core/js/page-language",
    "position": "core/js/position",
    "control-spacing": "core/js/control-spacing",
});

function withoutExtension(file)
{
    return file.replace(/\.(m?js)$/u, "");
}

function runtimeIdFor({ context, request, issuer }, sourceRoot)
{
    if (!request || (issuer && issuer.includes(`${path.sep}node_modules${path.sep}`)))
    {
        return null;
    }
    if (BARE_MODULES.includes(request))
    {
        return request;
    }
    if (!request.startsWith(".") || !context)
    {
        return null;
    }
    const target = withoutExtension(path.resolve(context, request));
    for (const [id, relative] of Object.entries(CORE_MODULES))
    {
        if (target === path.join(sourceRoot, relative))
        {
            return id;
        }
    }

    return null;
}

function applySharedRuntimeExternals(configurations, { sourceRoot })
{
    if (!Array.isArray(configurations))
    {
        throw new TypeError("configurations must be an array");
    }
    const root = path.resolve(sourceRoot);

    for (const configuration of configurations)
    {
        configuration.externalsType = "promise";
        configuration.externals = [
            ({ context, request, contextInfo }, callback) => {
                const id = runtimeIdFor({ context, request, issuer: contextInfo && contextInfo.issuer }, root);
                if (!id)
                {
                    callback();
                    return;
                }
                // Core's lookup when Core is on the page; otherwise the runtime
                // script's, once it has run (a page that includes it by hand).
                const key = JSON.stringify(id);
                callback(null, `(globalThis.SF && globalThis.SF.runtimeModule ? globalThis.SF.runtimeModule(${key}) : new Promise((resolve) => globalThis.addEventListener("sf-runtime-ready", () => resolve(globalThis.SF.runtimeModule(${key})), { once: true })))`);
            },
        ];
    }

    return configurations;
}

module.exports = {
    BARE_MODULES,
    CORE_MODULES,
    applySharedRuntimeExternals,
    runtimeIdFor,
};
