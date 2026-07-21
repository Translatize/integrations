import type { LabelRecord } from "@translatize/core";

/** A value counts as "translated" when it is a present, non-empty string. */
export function isNonEmpty(value: string | undefined): boolean {
    return typeof value === "string" && value !== "";
}

/** Round a translated/total ratio to a whole-number percent; an empty branch is 100% complete. */
export function percent(translated: number, total: number): number {
    return total === 0 ? 100 : Math.round((translated / total) * 100);
}

/** Per-language coverage over a label set, plus a capped sample of the untranslated keys. */
export interface LanguageSummary {
    translated: number;
    missing: number;
    /** Keys with no non-empty value in this language, in the order given (server sorts by key), capped at `missingLimit`. */
    missingKeys: string[];
}

/**
 * Single-pass coverage for one language across `labels`. Pass `missingLimit = 0` when
 * only the counts are needed (e.g. computing a completeness percentage).
 */
export function summarizeLanguage(labels: LabelRecord[], lang: string, missingLimit = 50): LanguageSummary {
    let translated = 0;
    const missingKeys: string[] = [];
    for (const label of labels) {
        if (isNonEmpty(label.values?.[lang])) {
            translated++;
        } else if (missingKeys.length < missingLimit) {
            missingKeys.push(label.key);
        }
    }
    return { translated, missing: labels.length - translated, missingKeys };
}

/** Where {@link matchesLabel} looks: key names, translation values, or either. */
export type SearchScope = "keys" | "values" | "both";

/** True when `label` matches `lowerQuery` (already lower-cased) within the requested scope. */
export function matchesLabel(label: LabelRecord, lowerQuery: string, scope: SearchScope): boolean {
    if (scope !== "values" && label.key.toLowerCase().includes(lowerQuery)) {
        return true;
    }
    if (scope !== "keys") {
        for (const value of Object.values(label.values ?? {})) {
            if (typeof value === "string" && value.toLowerCase().includes(lowerQuery)) {
                return true;
            }
        }
    }
    return false;
}
