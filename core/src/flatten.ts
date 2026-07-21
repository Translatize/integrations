// Convert between the nested JSON people author translations in and the flat
// `dot.separated.key -> value` map the API and CLI exchange. For valid input (all
// leaves are strings, no empty objects) `flatten` and `unflatten` are exact inverses.

type Nested = Record<string, unknown>;

function describeType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

// A value we recurse into: a real `{...}` object, not an array, Date, class
// instance, etc. Anything else is a leaf (and must therefore be a string).
function isPlainObject(value: unknown): value is Nested {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Flatten a nested object into a map of dotted keys to string values.
 * Empty objects are dropped; a non-string leaf throws an error naming its path.
 */
export function flatten(nested: Nested, sep = "."): Record<string, string> {
    const out: Record<string, string> = {};

    // `hasPrefix` distinguishes "no prefix accumulated yet" (root) from "prefix is the
    // empty string" (an empty top-level key). Without it a leading empty segment would
    // be dropped, breaking the exact-inverse guarantee for keys like ".hidden".
    const walk = (value: unknown, prefix: string, hasPrefix: boolean): void => {
        if (isPlainObject(value)) {
            // An empty object contributes no leaf and is dropped entirely.
            for (const key of Object.keys(value)) {
                const nextPrefix = hasPrefix ? `${prefix}${sep}${key}` : key;
                walk(value[key], nextPrefix, true);
            }
            return;
        }
        if (typeof value !== "string") {
            const at = hasPrefix ? prefix : "(root)";
            throw new Error(`flatten: value at "${at}" must be a string, got ${describeType(value)}`);
        }
        out[prefix] = value;
    };

    walk(nested, "", false);
    return out;
}

// Path segments that, if walked as object keys, would reach into the prototype chain
// and let a crafted flat key mutate `Object.prototype` (CWE-1321). Rejected outright.
const UNSAFE_KEY_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Inverse of {@link flatten}: expand a map of dotted keys back into a nested object.
 * Throws on a parent/child conflict (e.g. both `"a"` and `"a.b"` present), a
 * non-string value, or a prototype-polluting key segment.
 */
export function unflatten(flat: Record<string, string>, sep = "."): Nested {
    const root: Nested = {};

    for (const flatKey of Object.keys(flat)) {
        const value = flat[flatKey];
        if (typeof value !== "string") {
            throw new Error(`unflatten: value at "${flatKey}" must be a string, got ${describeType(value)}`);
        }

        const parts = flatKey.split(sep);
        for (const part of parts) {
            if (UNSAFE_KEY_SEGMENTS.has(part)) {
                throw new Error(`unflatten: unsafe key segment "${part}" in "${flatKey}"`);
            }
        }
        let node: Nested = root;

        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const existing = node[part];
            if (existing === undefined) {
                const child: Nested = {};
                node[part] = child;
                node = child;
            } else if (isPlainObject(existing)) {
                node = existing;
            } else {
                const conflictPath = parts.slice(0, i + 1).join(sep);
                throw new Error(`unflatten: key conflict at "${conflictPath}" – used as both a value and a parent object`);
            }
        }

        const leaf = parts[parts.length - 1];
        if (Object.prototype.hasOwnProperty.call(node, leaf)) {
            throw new Error(`unflatten: key conflict at "${flatKey}" – assigned both a value and a nested object`);
        }
        node[leaf] = value;
    }

    return root;
}
