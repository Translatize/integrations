import type { OtaDistribution, PublishReleaseResult, TranslatizeClient } from "@translatize/core";
import { UsageError } from "../config.js";
import { createColors, info, printJson, warn, type Colors } from "../ui.js";
import { buildApiContext, type GlobalOpts } from "./shared.js";

export interface ReleaseOpts extends GlobalOpts {
    distribution?: string;
    json?: boolean;
}

function describeDistribution(d: OtaDistribution): string {
    return `  ${d.id}  "${d.name}"  branch ${d.branch}${d.status === "disabled" ? "  (disabled)" : ""}`;
}

/**
 * Pick the distribution to publish: the one `--distribution` names (by id,
 * public id or name), else the only one left after the `--branch` filter.
 * Anything ambiguous is a usage error that lists the choices.
 */
export function pickDistribution(
    distributions: OtaDistribution[],
    opts: { distribution?: string; branch?: string },
): OtaDistribution {
    const wanted = (opts.distribution ?? "").trim();
    const branch = (opts.branch ?? "").trim();
    if (distributions.length === 0) {
        // the API lists only distributions of branches this token may use
        throw new UsageError(
            "No OTA distribution publishes a branch this token may use. Create one under Project Settings -> Delivery in the app, " +
                "or use a token bound to the distribution's branch.",
        );
    }
    const list = distributions.map(describeDistribution).join("\n");

    if (wanted !== "") {
        let found = distributions.filter((d) => d.id === wanted || d.publicId === wanted);
        if (found.length === 0) {
            found = distributions.filter((d) => d.name === wanted);
        }
        if (found.length === 0) {
            throw new UsageError(`No distribution "${wanted}" among those this token can see:\n${list}`);
        }
        if (found.length > 1) {
            throw new UsageError(`Several distributions are named "${wanted}". Pass its id instead:\n${found.map(describeDistribution).join("\n")}`);
        }
        const pick = found[0];
        if (branch !== "" && pick.branch !== branch) {
            throw new UsageError(`Distribution "${pick.name}" publishes branch "${pick.branch}", not "${branch}".`);
        }
        return pick;
    }

    const candidates = branch !== "" ? distributions.filter((d) => d.branch === branch) : distributions;
    if (candidates.length === 0) {
        throw new UsageError(`No distribution publishes branch "${branch}" among those this token can see:\n${list}`);
    }
    if (candidates.length > 1) {
        throw new UsageError(
            `This project has ${candidates.length} distributions${branch !== "" ? ` for branch "${branch}"` : ""}. ` +
                `Pick one with --distribution <id>:\n${candidates.map(describeDistribution).join("\n")}`,
        );
    }
    return candidates[0];
}

/** The client calls a release makes – a seam for tests. */
export type ReleaseClient = Pick<TranslatizeClient, "listDistributions" | "publishRelease">;

export async function publishOta(
    client: ReleaseClient,
    opts: { distribution?: string; branch?: string },
): Promise<{ distribution: OtaDistribution; result: PublishReleaseResult }> {
    const { distributions } = await client.listDistributions();
    const distribution = pickDistribution(distributions ?? [], opts);
    const result = await client.publishRelease(distribution.id);
    return { distribution, result };
}

/** `translatize release` – publish a distribution's branch to the CDN as a new version. */
export async function releaseCommand(opts: ReleaseOpts): Promise<number> {
    const colors = createColors();
    const ctx = buildApiContext(opts);
    // --branch only narrows the choice of distribution; the config "branch" is a working branch for pull/push.
    const { distribution, result } = await publishOta(ctx.client, { distribution: opts.distribution, branch: opts.branch });

    if (opts.json) {
        printJson({
            command: "release",
            distribution: { id: distribution.id, name: distribution.name, publicId: distribution.publicId, branch: distribution.branch },
            version: result.release.version,
            labelCount: result.release.labelCount,
            languages: Object.keys(result.release.languages ?? {}),
            manifestUrl: result.manifestUrl,
            ok: true,
        });
        return 0;
    }
    renderRelease(colors, distribution, result);
    return 0;
}

function renderRelease(colors: Colors, distribution: OtaDistribution, result: PublishReleaseResult): void {
    const langs = Object.keys(result.release.languages ?? {});
    info(
        colors.green(`Published version ${result.release.version}`) +
            ` of "${colors.bold(distribution.name)}" (branch ${distribution.branch}) – ${result.release.labelCount} key(s), ` +
            `${langs.length} language(s)${langs.length > 0 ? `: ${langs.join(", ")}` : ""}`,
    );
    info(`  manifest: ${result.manifestUrl}`);
    if (distribution.status === "disabled") {
        warn(colors, "this distribution is disabled – the CDN serves it again once it is enabled in the app.");
    }
    info(colors.dim("Anything you publish is public – never put secrets in translations."));
}
