import { assemblePull, computeFilePlan, type FilesByLang } from "../diff.js";
import { displayPath, readLangFile, writeLangFile } from "../files.js";
import { serializeTranslationFile } from "../serialize.js";
import { createColors, info, printJson, type Colors } from "../ui.js";
import { buildContext, listOptions, warnOnProjectMismatch, type GlobalOpts } from "./shared.js";

export interface PullOpts extends GlobalOpts {
    dryRun?: boolean;
    json?: boolean;
}

interface FileResult {
    lang: string;
    path: string;
    status: "create" | "update" | "unchanged";
    exists: boolean;
    added: number;
    changed: number;
    removed: number;
    total: number;
    written: boolean;
}

/** `translatize pull` – download the branch and write one file per language. */
export async function pullCommand(opts: PullOpts): Promise<number> {
    const colors = createColors();
    const ctx = buildContext(opts);
    const dryRun = Boolean(opts.dryRun);

    const me = await ctx.client.me();
    warnOnProjectMismatch(colors, ctx.config, me);
    const langs = me.project.langs;

    const list = await ctx.client.listLabels(listOptions(ctx));
    const byLang: FilesByLang = assemblePull(list.labels, langs);

    const results: FileResult[] = [];
    for (const lang of langs) {
        const next = byLang[lang] ?? {};
        const existing = readLangFile(ctx.config.files, lang, ctx.baseDir);
        const plan = computeFilePlan(existing ? existing.flat : null, next);
        const newText = serializeTranslationFile(next, ctx.config.format);
        const contentChanged = existing === null || existing.raw !== newText;

        const status: FileResult["status"] = !plan.exists ? "create" : contentChanged ? "update" : "unchanged";
        let written = false;
        if (!dryRun && contentChanged) {
            writeLangFile(ctx.config.files, lang, newText, ctx.baseDir);
            written = true;
        }
        results.push({
            lang,
            path: displayPath(ctx.config.files, lang),
            status,
            exists: plan.exists,
            added: plan.added,
            changed: plan.changed,
            removed: plan.removed,
            total: plan.total,
            written,
        });
    }

    if (opts.json) {
        printJson({ command: "pull", branch: list.branch, project: me.project.name, dryRun, files: results });
        return 0;
    }

    renderPull(colors, me.project.name, list.branch, list.total, dryRun, results);
    return 0;
}

function renderPull(
    colors: Colors,
    project: string,
    branch: string,
    remoteKeys: number,
    dryRun: boolean,
    results: FileResult[],
): void {
    const suffix = dryRun ? colors.dim(" (dry run)") : "";
    info(
        `Pulling from "${colors.bold(project)}" (branch ${colors.bold(branch)}) – ` +
            `${results.length} language(s), ${remoteKeys} key(s)${suffix}`,
    );
    if (results.length === 0) {
        info(colors.dim("  Project has no languages configured."));
        return;
    }

    const pathWidth = Math.max(...results.map((result) => result.path.length));
    for (const result of results) {
        const label = statusLabel(colors, result.status);
        const counts = `+${result.added} ~${result.changed} -${result.removed}`;
        info(`  ${result.path.padEnd(pathWidth)}  ${label}  ${counts.padEnd(12)}  ${colors.dim(`${result.total} key(s)`)}`);
    }

    const writes = results.filter((result) => result.written).length;
    info("");
    if (dryRun) {
        const pending = results.filter((result) => result.status !== "unchanged").length;
        info(pending > 0 ? colors.dim(`Dry run – ${pending} file(s) would change, none written.`) : colors.dim("Dry run – everything is up to date."));
    } else {
        info(writes > 0 ? colors.green(`Wrote ${writes} file(s).`) : colors.dim("Already up to date – nothing written."));
    }
}

function statusLabel(colors: Colors, status: FileResult["status"]): string {
    const labelWidth = 9;
    if (status === "create") return colors.green("create".padEnd(labelWidth));
    if (status === "update") return colors.yellow("update".padEnd(labelWidth));
    return colors.dim("unchanged".padEnd(labelWidth));
}
