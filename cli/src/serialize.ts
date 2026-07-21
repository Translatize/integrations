import { flatten, unflatten } from "@translatize/core";
import { UsageError, type TranslationFormat } from "./config.js";

/** A flat `dot.separated.key -> value` translation map. */
export type FlatMap = Record<string, string>;

function sortedFlat(flat: FlatMap): FlatMap {
    const out: FlatMap = {};
    for (const key of Object.keys(flat).sort()) {
        out[key] = flat[key];
    }
    return out;
}

/**
 * Render a flat translation map as file text in the given format. Keys are sorted
 * for stable, diff-friendly output; a trailing newline is appended.
 *
 * `json-nested` un-flattens dotted keys into nested objects; if that is impossible
 * (a key is used as both a value and a parent, e.g. `a` and `a.b`) a
 * {@link UsageError} suggests switching to `json-flat`.
 */
export function serializeTranslationFile(flat: FlatMap, format: TranslationFormat): string {
    const sorted = sortedFlat(flat);
    let value: unknown = sorted;
    if (format === "json-nested") {
        try {
            value = unflatten(sorted);
        } catch (err) {
            throw new UsageError(
                `Cannot represent these keys as nested JSON: ${(err as Error).message}. ` +
                    `Set "format": "json-flat" in your config.`,
            );
        }
    }
    return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Parse translation file text into a flat map. Accepts both nested and already-flat
 * JSON objects (nested objects are flattened; a flat file passes through unchanged).
 * Throws {@link UsageError} – naming `filename` – on invalid JSON, a non-object root,
 * or a non-string leaf value.
 */
export function parseTranslationFile(text: string, filename: string): FlatMap {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new UsageError(`${filename}: not valid JSON – ${(err as Error).message}`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new UsageError(`${filename}: expected a JSON object of translations`);
    }
    try {
        return flatten(data as Record<string, unknown>);
    } catch (err) {
        throw new UsageError(`${filename}: ${(err as Error).message}`);
    }
}
