import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseTranslationFile, type FlatMap } from "./serialize.js";

/** Substitute `{lang}` in a files pattern (all occurrences). */
export function displayPath(pattern: string, lang: string): string {
    return pattern.split("{lang}").join(lang);
}

/** Absolute on-disk path for a language, resolving the pattern against `baseDir`. */
export function langPath(pattern: string, lang: string, baseDir: string): string {
    return resolve(baseDir, displayPath(pattern, lang));
}

/** A language file read from disk: its flat map plus the raw text (for no-op write detection). */
export interface ReadFile {
    flat: FlatMap;
    raw: string;
}

/** Read and parse a language file. Returns `null` when the file does not exist. */
export function readLangFile(pattern: string, lang: string, baseDir: string): ReadFile | null {
    const abs = langPath(pattern, lang, baseDir);
    let raw: string;
    try {
        raw = readFileSync(abs, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }
    return { flat: parseTranslationFile(raw, displayPath(pattern, lang)), raw };
}

/** Write a language file, creating parent directories as needed. */
export function writeLangFile(pattern: string, lang: string, content: string, baseDir: string): void {
    const abs = langPath(pattern, lang, baseDir);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
}
