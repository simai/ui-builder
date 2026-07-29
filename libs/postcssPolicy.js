"use strict";

const path = require("node:path");

const LOGICAL_PROPERTIES_FEATURE = "logical-properties-and-values";
const LATE_LOGICAL_FALLBACK_PLUGIN = path.resolve(
    __dirname,
    "postcssLateLogicalFallbacks.js",
);

function cloneJsonLike(value)
{
    if (Array.isArray(value))
    {
        return value.map(cloneJsonLike);
    }

    if (value && typeof value === "object")
    {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                cloneJsonLike(entry),
            ]),
        );
    }

    return value;
}

function createPostcssPresetEnvOptions(options = {})
{
    const cloned = cloneJsonLike(options);
    const features = cloned.features && typeof cloned.features === "object"
        ? cloned.features
        : {};
    const logicalFeature = features[LOGICAL_PROPERTIES_FEATURE]
        && typeof features[LOGICAL_PROPERTIES_FEATURE] === "object"
        ? features[LOGICAL_PROPERTIES_FEATURE]
        : {};

    return {
        ...cloned,
        features: {
            ...features,
            [LOGICAL_PROPERTIES_FEATURE]: {
                ...logicalFeature,
                preserve: true,
            },
        },
    };
}

function createPostcssPlugins(options = {})
{
    return [
        [
            "postcss-preset-env",
            createPostcssPresetEnvOptions(options),
        ],
        [LATE_LOGICAL_FALLBACK_PLUGIN, {}],
    ];
}

function createPostcssOptions(options = {})
{
    return {
        plugins: createPostcssPlugins(options),
    };
}

function assertRtlSafePostcssPlugins(plugins, label = "postcss plugins")
{
    if (!Array.isArray(plugins))
    {
        throw new TypeError(`${label} must be an array`);
    }

    const preset = plugins.find(plugin =>
        Array.isArray(plugin)
        && plugin.length === 2
        && plugin[0] === "postcss-preset-env");

    if (!preset
        || !preset[1]
        || typeof preset[1] !== "object"
        || !preset[1].features
        || typeof preset[1].features !== "object"
        || !preset[1].features[LOGICAL_PROPERTIES_FEATURE]
        || preset[1].features[LOGICAL_PROPERTIES_FEATURE].preserve !== true)
    {
        throw new TypeError(
            `${label} must preserve ${LOGICAL_PROPERTIES_FEATURE}`,
        );
    }

    const cleanup = plugins.find(plugin =>
        Array.isArray(plugin)
        && plugin.length === 2
        && plugin[0] === LATE_LOGICAL_FALLBACK_PLUGIN);

    if (!cleanup)
    {
        throw new TypeError(
            `${label} must remove late generated logical fallbacks`,
        );
    }

    return true;
}

module.exports = {
    LOGICAL_PROPERTIES_FEATURE,
    LATE_LOGICAL_FALLBACK_PLUGIN,
    assertRtlSafePostcssPlugins,
    createPostcssOptions,
    createPostcssPlugins,
    createPostcssPresetEnvOptions,
};
