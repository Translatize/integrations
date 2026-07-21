import { computeStatus, filterFilesByNamespace, type FilesByLang, type StatusResult } from "../diff.js";
import { displayPath, readLangFile } from "../files.js";
import { createColors, info, printJson, sampleKeys, table, type Colors } from "../ui.js";
import { buildContext, listOptions, warnOnProjectMismatch, type GlobalOpts } from "./shared.js";

export interface StatusOpts extends GlobalOpts {
    failOnMissing?: boolean;
    failOnDiff?: boolean;
    json?: boolean;
}

/** `translatize status` – compare local files with the branch; the CI gate. */
export async function statusCommand(opts: StatusOpts): Promise<number> {
    const colors = createColors();
    const ctx = buildContext(opts);

    const me = await ctx.client.me();
    warnOnProjectMismatch(colors, ctx.config, me);
    const langs = me.project.langs;

    const byLang: FilesByLang = {};
    for (const lang of langs) {
        const file = readLangFile(ctx.config.files, lang, ctx.baseDir);
        byLang[lang] = file ? file.flat : {};
    }

    let scoped = byLang;
    if (ctx.config.namespace) {
        scoped = filterFilesByNamespace(byLang, ctx.config.namespace).files;
    }

    const list = await ctx.client.listLabels(listOptions(ctx));
    const status = computeStatus(scoped, list.labels, langs);

    const failOnMissing = Boolean(opts.failOnMissing);
    const failOnDiff = Boolean(opts.failOnDiff);
    const failed = (failOnMissing && status.hasMissing) || (failOnDiff && status.hasDiff);

    if (opts.json) {
        printJson({
            command: "status",
            branch: list.branch,
            project: me.project.name,
            totalRemoteKeys: status.totalRemoteKeys,
            languages: status.languages,
            onlyLocal: status.onlyLocal,
            onlyRemote: status.onlyRemote,
            differing: status.differing,
            failOnMissing,
            failOnDiff,
            ok: !failed,
        });
        return failed ? 1 : 0;
    }

    renderStatus(colors, me.project.name, list.branch, status);
    renderGate(colors, status, failOnMissing, failOnDiff, failed);
    return failed ? 1 : 0;
}

function percent(translated: number, total: number): number {
    return total === 0 ? 100 : Math.round((translated / total) * 100);
}

function renderStatus(colors: Colors, project: string, branch: string, status: StatusResult): void {
    info(`Status of "${colors.bold(project)}" (branch ${colors.bold(branch)}) – ${status.totalRemoteKeys} remote key(s)`);
    info("");

    const rows = status.languages.map((langStat) => [langStat.lang, `${langStat.translated}/${langStat.total}`, `${percent(langStat.translated, langStat.total)}%`]);
    info(table(colors, ["Language", "Translated", "Complete"], rows));
    info("");

    renderKeyGroup(colors, "only local (not on the branch)", status.onlyLocal);
    renderKeyGroup(colors, "only remote (missing locally)", status.onlyRemote);
    renderKeyGroup(colors, "value differs from the branch", status.differing);
}

function renderKeyGroup(colors: Colors, label: string, keys: string[]): void {
    if (keys.length === 0) {
        return;
    }
    info(`${keys.length} key(s) ${label}:`);
    info(colors.dim(`  ${sampleKeys(keys)}`));
    info("");
}

function renderGate(colors: Colors, status: StatusResult, failOnMissing: boolean, failOnDiff: boolean, failed: boolean): void {
    if (failed) {
        const reasons: string[] = [];
        if (failOnMissing && status.hasMissing) {
            reasons.push("missing translations");
        }
        if (failOnDiff && status.hasDiff) {
            reasons.push("local/remote differences");
        }
        info(colors.red(`FAIL: ${reasons.join(" and ")}.`));
        return;
    }
    if (status.hasMissing || status.hasDiff) {
        info(colors.yellow("Differences found (no gate enabled – exit 0)."));
    } else {
        info(colors.green("In sync – local files match the branch."));
    }
}
