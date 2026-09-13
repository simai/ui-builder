"use strict";

const DIRECTIONAL_SELECTOR = /^\[dir=(?:["'])?(?:ltr|rtl)(?:["'])?\]\s+/;

function normalizeValue(value)
{
    return value.trim().replace(/\s+/g, " ");
}

function varFallback(value)
{
    const source = value.trim();

    if (!source.startsWith("var("))
    {
        return null;
    }

    let depth = 0;
    let comma = -1;

    for (let index = 4; index < source.length - 1; index += 1)
    {
        const character = source[index];

        if (character === "(")
        {
            depth += 1;
        }
        else if (character === ")")
        {
            depth -= 1;
        }
        else if (character === "," && depth === 0)
        {
            comma = index;
            break;
        }
    }

    if (comma === -1 || !source.endsWith(")"))
    {
        return null;
    }

    return normalizeValue(source.slice(comma + 1, -1));
}

function declarationNodes(rule)
{
    return rule.nodes.filter(node => node.type === "decl");
}

function protectedFallbacks(rule)
{
    const declarations = declarationNodes(rule);
    const protectedValues = new Map();

    for (let index = 0; index < declarations.length - 1; index += 1)
    {
        const fallback = declarations[index];
        const variable = declarations[index + 1];

        if (fallback.prop !== variable.prop)
        {
            continue;
        }

        const fallbackValue = normalizeValue(fallback.value);
        let expectedFallback = varFallback(variable.value);

        // preset-env can collapse several alias levels to a semantic token.
        // That token is still only a fallback, not a later author override.
        while (expectedFallback !== null && expectedFallback !== fallbackValue)
        {
            expectedFallback = varFallback(expectedFallback);
        }

        if (expectedFallback === null
            || fallbackValue !== expectedFallback)
        {
            continue;
        }

        if (!protectedValues.has(fallback.prop))
        {
            protectedValues.set(fallback.prop, new Set());
        }

        protectedValues.get(fallback.prop).add(expectedFallback);
    }

    return protectedValues;
}

function mergeProtected(target, source)
{
    for (const [property, values] of source)
    {
        if (!target.has(property))
        {
            target.set(property, new Set());
        }

        for (const value of values)
        {
            target.get(property).add(value);
        }
    }
}

function createLateLogicalFallbackCleanup()
{
    return {
        postcssPlugin: "simai-late-logical-fallback-cleanup",
        OnceExit(root)
        {
            const protectedByParent = new WeakMap();

            root.walkRules(rule => {
                if (!protectedByParent.has(rule.parent))
                {
                    protectedByParent.set(rule.parent, new Map());
                }
                const protectedBySelector = protectedByParent.get(rule.parent);
                const selector = rule.selector;
                const declarations = declarationNodes(rule);
                const pairs = protectedFallbacks(rule);

                if (pairs.size > 0)
                {
                    if (!protectedBySelector.has(selector))
                    {
                        protectedBySelector.set(selector, new Map());
                    }

                    mergeProtected(protectedBySelector.get(selector), pairs);

                    return;
                }

                if (!DIRECTIONAL_SELECTOR.test(selector)
                    || declarations.length !== 1
                    || rule.nodes.length !== 1)
                {
                    return;
                }

                const declaration = declarations[0];
                const protectedForSelector = protectedBySelector.get(selector);
                const protectedForProperty = protectedForSelector
                    && protectedForSelector.get(declaration.prop);

                if (protectedForProperty
                    && protectedForProperty.has(normalizeValue(declaration.value)))
                {
                    rule.remove();
                }
            });
        },
    };
}

createLateLogicalFallbackCleanup.postcss = true;

module.exports = createLateLogicalFallbackCleanup;
module.exports.varFallback = varFallback;
