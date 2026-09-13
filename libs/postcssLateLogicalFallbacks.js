"use strict";

const postcss = require("postcss");
const legacyDirection = require("postcss-dir-pseudo-class")({ dir: "ltr" });

const NATIVE_DIRECTIONAL_SELECTOR = /:dir\((?:ltr|rtl)\)/;
const DIRECTIONAL_SELECTOR = /^\[dir=(?:["'])?(?:ltr|rtl)(?:["'])?\]\s+/;

function normalizeValue(value)
{
    return value.trim().replace(/\s+/g, " ");
}

function normalizeSelectorLineEnds(selector)
{
    // postcss-dir-pseudo-class can preserve indentation before a newline when
    // it prefixes every member of a multiline selector list. The newline is
    // already the descendant combinator, so horizontal whitespace before it
    // is redundant and makes generated repository diffs fail whitespace
    // checks.
    return selector.replace(/[ \t]+(?=\r?\n|$)/g, "");
}

function varFallback(value)
{
    const source = value.trim();

    // Negative spacing wraps var() in calc(); compare its generated constant
    // expression without evaluating CSS arithmetic or changing the var() rule.
    if (source.startsWith("calc(") && source.endsWith(")"))
    {
        const start = source.indexOf("var(");
        let depth = 0;

        for (let index = start + 3; start >= 0 && index < source.length; index += 1)
        {
            if (source[index] === "(") depth += 1;
            if (source[index] === ")") depth -= 1;
            if (depth !== 0) continue;

            const fallback = varFallback(source.slice(start, index + 1));
            const expression = fallback === null ? null
                : source.slice(0, start) + fallback + source.slice(index + 1);

            return expression === null || expression.includes("var(")
                ? null : normalizeValue(expression);
        }

        return null;
    }

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


function logicalSupport(declaration, direction)
{
    const { prop, value } = declaration;
    const side = physical => (physical === "left") === (direction === "ltr")
        ? "start" : "end";
    const spacing = /^(margin|padding)-(left|right)$/.exec(prop);
    if (spacing) return `${spacing[1]}-inline-${side(spacing[2])}: initial`;
    const border = /^border-(left|right)(-(width|style|color))?$/.exec(prop);
    if (border) return `border-inline-${side(border[1])}${border[2] || ""}: initial`;
    if (prop === "left" || prop === "right")
        return `inset-inline-${side(prop)}: initial`;
    const radius = /^border-(top|bottom)-(left|right)-radius$/.exec(prop);
    if (radius) return `border-${radius[1] === "top" ? "start" : "end"}-${side(radius[2])}-radius: initial`;
    if ((prop === "float" || prop === "clear") && /^(left|right)$/.test(value))
        return `${prop}: inline-${side(value)}`;
    if (prop === "text-align" && /^(left|right)$/.test(value))
        return `${prop}: ${side(value)}`;
    return null;
}

function addLegacyFallbacks(root, result)
{
    const rules = [];
    root.walkRules(rule => {
        if (NATIVE_DIRECTIONAL_SELECTOR.test(rule.selector)) rules.push(rule);
    });
    for (const rule of rules)
    {
        const direction = NATIVE_DIRECTIONAL_SELECTOR.exec(rule.selector)[0].slice(5, -1);
        const groups = new Map();
        for (const declaration of declarationNodes(rule))
        {
            const condition = logicalSupport(declaration, direction);
            if (!condition) continue;
            if (!groups.has(condition)) groups.set(condition, []);
            groups.get(condition).push(declaration);
        }
        for (const [condition, declarations] of groups)
        {
            const fallback = rule.clone({ nodes: declarations.map(node => node.clone()) });
            // Reuse the existing preset dependency; never implement another selector converter.
            legacyDirection.Rule(fallback, { result });
            fallback.selector = normalizeSelectorLineEnds(fallback.selector);
            // IE 10/11 has no @supports. This recognized IE pseudo-class makes the
            // whole selector list invalid elsewhere, keeping it out of modern cascades.
            rule.before(fallback.clone({ selector: `_:-ms-input-placeholder, ${fallback.selector}` }));
            rule.before(postcss.atRule({ name: "supports", params: `not (${condition})` })
                .append(fallback));
        }
        if (groups.size > 0)
        {
            // Direction chooses a side, not extra specificity over later utilities.
            rule.selector = rule.selector.replace(/:dir\((ltr|rtl)\)/g, ":where(:dir($1))");
        }
    }
}

function createLateLogicalFallbackCleanup()
{
    return {
        postcssPlugin: "simai-late-logical-fallback-cleanup",
        OnceExit(root, { result })
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

                if ((!DIRECTIONAL_SELECTOR.test(selector)
                    && !NATIVE_DIRECTIONAL_SELECTOR.test(selector))
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

            addLegacyFallbacks(root, result);
        },
    };
}

createLateLogicalFallbackCleanup.postcss = true;

module.exports = createLateLogicalFallbackCleanup;
module.exports.varFallback = varFallback;
