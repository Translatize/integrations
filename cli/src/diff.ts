import type { LabelRecord } from "@translatize/core";
import type { FlatMap } from "./serialize.js";

/** A translation key with its non-empty per-language values, assembled from local files. */
export interface AssembledLabel {
    key: string;
    values: Record<string, string>;
}

/** Per-language flat maps keyed by language code. */
export type FilesByLang = Record<string, FlatMap>;

function nonEmpty(value: unknown): value is string {
    return typeof value === "string" && value !== "";
}

/**
 * Collapse per-language files into one entry per key holding only its non-empty
 * values. Keys with no non-empty value in any language are dropped entirely.
 * Result is sorted by key.
 */
export function assembleLocal(byLang: FilesByLang): AssembledLabel[] {
    const keys = new Set<string>();
    for (const lang of Object.keys(byLang)) {
        for (const key of Object.keys(byLang[lang])) {
            keys.add(key);
        }
    }
    const out: AssembledLabel[] = [];
    for (const key of [...keys].sort()) {
        const values: Record<string, string> = {};
        for (const lang of Object.keys(byLang)) {
            const value = byLang[lang][key];
            if (nonEmpty(value)) {
                values[lang] = value;
            }
        }
        if (Object.keys(values).length > 0) {
            out.push({ key, values });
        }
    }
    return out;
}

/** Index a remote label list by key, exposing each label's raw `values` map. */
export function indexRemote(remote: LabelRecord[]): Map<string, Record<string, string>> {
    const map = new Map<string, Record<string, string>>();
    for (const label of remote) {
        map.set(label.key, label.values ?? {});
    }
    return map;
}

/**
 * True when `local` carries any non-empty value that disagrees with `remote`
 * (a missing remote value counts as ""). Languages absent from `local` are ignored,
 * so this measures "would pushing local change remote?", not completeness.
 */
export function valuesDiffer(local: Record<string, string>, remote: Record<string, string>): boolean {
    for (const lang of Object.keys(local)) {
        if (local[lang] !== (remote[lang] ?? "")) {
            return true;
        }
    }
    return false;
}

/** The plan for a `push`: which local keys are new, changed, unchanged, and which remote keys have no local counterpart. */
export interface PushPlan {
    create: AssembledLabel[];
    update: AssembledLabel[];
    unchanged: string[];
    /** Remote keys with no non-empty local value – never deleted by push, only reported. */
    remoteOnly: string[];
}

/** Compute which assembled local labels need creating/updating versus the remote branch. */
export function computePushDiff(local: AssembledLabel[], remote: LabelRecord[]): PushPlan {
    const remoteMap = indexRemote(remote);
    const localKeys = new Set(local.map((label) => label.key));
    const create: AssembledLabel[] = [];
    const update: AssembledLabel[] = [];
    const unchanged: string[] = [];

    for (const label of local) {
        const remoteValues = remoteMap.get(label.key);
        if (remoteValues === undefined) {
            create.push(label);
        } else if (valuesDiffer(label.values, remoteValues)) {
            update.push(label);
        } else {
            unchanged.push(label.key);
        }
    }

    const remoteOnly: string[] = [];
    for (const label of remote) {
        if (!localKeys.has(label.key)) {
            remoteOnly.push(label.key);
        }
    }
    remoteOnly.sort();

    return { create, update, unchanged, remoteOnly };
}

/**
 * Build the per-language files a `pull` would write: for each language, the keys
 * whose value in that language is non-empty. Keys with an empty/missing value for
 * a language are omitted from that language's file.
 */
export function assemblePull(labels: LabelRecord[], langs: string[]): FilesByLang {
    const out: FilesByLang = {};
    for (const lang of langs) {
        out[lang] = {};
    }
    for (const label of labels) {
        const values = label.values ?? {};
        for (const lang of langs) {
            const value = values[lang];
            if (nonEmpty(value)) {
                out[lang][label.key] = value;
            }
        }
    }
    return out;
}

/** What writing `next` over `current` (null = file does not yet exist) would change. */
export interface FilePlan {
    exists: boolean;
    added: number;
    changed: number;
    removed: number;
    /** Total keys in the file after the write. */
    total: number;
}

/** Compare the would-be file contents against what is on disk. */
export function computeFilePlan(current: FlatMap | null, next: FlatMap): FilePlan {
    const total = Object.keys(next).length;
    if (current === null) {
        return { exists: false, added: total, changed: 0, removed: 0, total };
    }
    let added = 0;
    let changed = 0;
    let removed = 0;
    for (const key of Object.keys(next)) {
        if (!(key in current)) {
            added++;
        } else if (current[key] !== next[key]) {
            changed++;
        }
    }
    for (const key of Object.keys(current)) {
        if (!(key in next)) {
            removed++;
        }
    }
    return { exists: true, added, changed, removed, total };
}

/** Per-language completeness: how many remote keys have a non-empty local translation. */
export interface LangCompleteness {
    lang: string;
    translated: number;
    total: number;
    missing: number;
}

/** The result of a `status` comparison of local files against the remote branch. */
export interface StatusResult {
    totalRemoteKeys: number;
    languages: LangCompleteness[];
    /** Keys present (non-empty) locally but not on the remote branch. */
    onlyLocal: string[];
    /** Remote keys absent (no non-empty value in any language) locally. */
    onlyRemote: string[];
    /** Keys whose local value disagrees with the remote value. */
    differing: string[];
    hasMissing: boolean;
    hasDiff: boolean;
}

/**
 * Compare local files against the remote branch: per-language completeness plus the
 * only-local / only-remote / value-differing key sets. `byLang` should contain an
 * entry for every project language (an empty map for a missing file).
 */
export function computeStatus(byLang: FilesByLang, remote: LabelRecord[], langs: string[]): StatusResult {
    const remoteMap = indexRemote(remote);
    const totalRemoteKeys = remoteMap.size;
    const localAssembled = assembleLocal(byLang);
    const localMap = new Map(localAssembled.map((label) => [label.key, label.values] as const));

    const languages: LangCompleteness[] = langs.map((lang) => {
        const file = byLang[lang] ?? {};
        let translated = 0;
        for (const key of remoteMap.keys()) {
            if (nonEmpty(file[key])) {
                translated++;
            }
        }
        return { lang, translated, total: totalRemoteKeys, missing: totalRemoteKeys - translated };
    });

    const onlyLocal: string[] = [];
    const differing: string[] = [];
    for (const { key, values } of localAssembled) {
        const remoteValues = remoteMap.get(key);
        if (remoteValues === undefined) {
            onlyLocal.push(key);
        } else if (valuesDiffer(values, remoteValues)) {
            differing.push(key);
        }
    }

    const onlyRemote: string[] = [];
    for (const key of remoteMap.keys()) {
        if (!localMap.has(key)) {
            onlyRemote.push(key);
        }
    }

    onlyLocal.sort();
    onlyRemote.sort();
    differing.sort();

    const hasMissing = languages.some((langStat) => langStat.missing > 0);
    const hasDiff = onlyLocal.length > 0 || onlyRemote.length > 0 || differing.length > 0;

    return { totalRemoteKeys, languages, onlyLocal, onlyRemote, differing, hasMissing, hasDiff };
}

/** Drop keys that do not begin with `"<namespace>."`. Used to scope operations to a namespace. */
export function filterFilesByNamespace(byLang: FilesByLang, namespace: string): { files: FilesByLang; dropped: number } {
    const prefix = `${namespace}.`;
    const files: FilesByLang = {};
    let dropped = 0;
    for (const lang of Object.keys(byLang)) {
        const kept: FlatMap = {};
        for (const key of Object.keys(byLang[lang])) {
            if (key.startsWith(prefix)) {
                kept[key] = byLang[lang][key];
            } else {
                dropped++;
            }
        }
        files[lang] = kept;
    }
    return { files, dropped };
}
