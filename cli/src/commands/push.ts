import type { BatchFailure } from "@translatize/core";
import { assembleLocal, computePushDiff, filterFilesByNamespace, type AssembledLabel, type FilesByLang } from "../diff.js";
import { displayPath, readLangFile } from "../files.js";
import { UsageError } from "../config.js";
import { createColors, info, printJson, sampleKeys, warn, type Colors } from "../ui.js";
import { buildContext, listOptions, warnOnProjectMismatch, type GlobalOpts } from "./shared.js";

export interface PushOpts extends GlobalOpts {
    dryRun?: boolean;
    json?: boolean;
}

/** `translatize push` – upload new and changed local keys to the branch (never deletes). */
export async function pushCommand(opts: PushOpts): Promise<number> {
    const colors = createColors();
    const ctx = buildContext(opts);
    const dryRun = Boolean(opts.dryRun);

    const me = await ctx.client.me();
    warnOnProjectMismatch(colors, ctx.config, me);
    const langs = me.project.langs;

    const byLang: FilesByLang = {};
    const missingLangs: string[] = [];
    for (const lang of langs) {
        const file = readLangFile(ctx.config.files, lang, ctx.baseDir);
        if (file === null) {
            missingLangs.push(lang);
            continue;
        }
        byLang[lang] = file.flat;
    }
    for (const lang of missingLangs) {
        warn(colors, `no file for language "${lang}" (${displayPath(ctx.config.files, lang)}), skipped`);
    }
    if (Object.keys(byLang).length === 0) {
        throw new UsageError(
            `No translation files found for pattern "${ctx.config.files}". ` +
                `Looked for: ${langs.map((lang) => displayPath(ctx.config.files, lang)).join(", ")}. ` +
                "Run `translatize pull` first, or check the `files` pattern in your config.",
        );
    }

    let scoped = byLang;
    if (ctx.config.namespace) {
        const filtered = filterFilesByNamespace(byLang, ctx.config.namespace);
        scoped = filtered.files;
        if (filtered.dropped > 0) {
            warn(colors, `${filtered.dropped} key(s) outside namespace "${ctx.config.namespace}" ignored`);
        }
    }

    const local = assembleLocal(scoped);
    const list = await ctx.client.listLabels(listOptions(ctx));
    const plan = computePushDiff(local, list.labels);
    const toSend = [...plan.create, ...plan.update];

    if (dryRun) {
        if (opts.json) {
            printJson({
                command: "push",
                branch: list.branch,
                dryRun: true,
                created: plan.create.length,
                updated: plan.update.length,
                unchanged: plan.unchanged.length,
                failed: [],
                remoteOnly: plan.remoteOnly,
                changes: changeList(plan.create, plan.update),
            });
            return 0;
        }
        renderDryRun(colors, list.branch, plan);
        return 0;
    }

    const result = await ctx.client.upsertLabels(
        toSend.map((label) => ({ key: label.key, values: label.values })),
        { branch: ctx.branch },
    );

    if (opts.json) {
        printJson({
            command: "push",
            branch: list.branch,
            dryRun: false,
            created: result.created,
            updated: result.updated,
            unchanged: plan.unchanged.length,
            failed: result.failed,
            remoteOnly: plan.remoteOnly,
        });
        return result.failed.length > 0 ? 1 : 0;
    }

    renderPush(colors, list.branch, result.created, result.updated, plan.unchanged.length, result.failed, plan.remoteOnly);
    return result.failed.length > 0 ? 1 : 0;
}

function changeList(create: AssembledLabel[], update: AssembledLabel[]): { key: string; kind: "create" | "update" }[] {
    return [
        ...create.map((label) => ({ key: label.key, kind: "create" as const })),
        ...update.map((label) => ({ key: label.key, kind: "update" as const })),
    ];
}

function renderDryRun(colors: Colors, branch: string, plan: ReturnType<typeof computePushDiff>): void {
    const pending = plan.create.length + plan.update.length;
    info(`Push preview (branch ${colors.bold(branch)}) – ${colors.dim("dry run, nothing sent")}`);
    if (pending === 0) {
        info(colors.green("  Nothing to push – remote is up to date."));
    } else {
        for (const label of plan.create) {
            info(`  ${colors.green("+")} ${label.key}`);
        }
        for (const label of plan.update) {
            info(`  ${colors.yellow("~")} ${label.key}`);
        }
        info("");
        info(`${plan.create.length} to create, ${plan.update.length} to update, ${plan.unchanged.length} unchanged.`);
    }
    renderRemoteOnly(colors, plan.remoteOnly);
}

function renderPush(
    colors: Colors,
    branch: string,
    created: number,
    updated: number,
    unchanged: number,
    failed: BatchFailure[],
    remoteOnly: string[],
): void {
    info(`Pushed to branch ${colors.bold(branch)}`);
    info(
        `  ${colors.green(`${created} created`)}, ${colors.yellow(`${updated} updated`)}, ` +
            `${colors.dim(`${unchanged} unchanged`)}${failed.length > 0 ? `, ${colors.red(`${failed.length} failed`)}` : ""}`,
    );
    if (failed.length > 0) {
        info("");
        info(colors.red("Failed:"));
        for (const failure of failed) {
            info(`  ${failure.key ?? "(unknown key)"}: ${failure.error}`);
        }
    }
    renderRemoteOnly(colors, remoteOnly);
}

function renderRemoteOnly(colors: Colors, remoteOnly: string[]): void {
    if (remoteOnly.length === 0) {
        return;
    }
    info("");
    info(
        colors.dim(
            `Note: ${remoteOnly.length} remote key(s) are not present locally. ` +
                "Translatize never deletes keys via push.",
        ),
    );
    const sample = sampleKeys(remoteOnly);
    if (sample) {
        info(colors.dim(`  ${sample}`));
    }
}
