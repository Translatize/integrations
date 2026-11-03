import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
    TranslatizeApiError,
    type CompleteScreenshotRunResult,
    type ScreenshotMeta,
    type ScreenshotUploadResult,
    type TranslatizeClient,
} from "@translatize/core";
import { UsageError } from "../config.js";
import { createColors, describeApiError, info, printJson, warn, type Colors } from "../ui.js";
import { buildApiContext, type GlobalOpts } from "./shared.js";

export interface ScreenshotsUploadOpts extends GlobalOpts {
    runName?: string;
    commitSha?: string;
    json?: boolean;
}

/** Where `@translatize/playwright` writes captures by default. */
export const DEFAULT_CAPTURE_DIR = ".translatize/captures";
/** Screens per capture run the server accepts (owner default D10 – keep in step with the backend). */
export const MAX_SCREENS_PER_RUN = 500;
// The server's meta limits (modules/screenshots/constants.js); one bad region would refuse the whole screen.
export const MAX_REGIONS_PER_SCREEN = 5000;
const MAX_REGION_TEXT = 10000;
const LOCALE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;
// A busy image pipeline answers 503; wait and try the screen again a few times.
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 5000;

/** One `<slug>.json` + `<slug>.png` pair read from the capture directory. */
export interface LocalCapture {
    slug: string;
    pngPath: string;
    /** sha256 hex of the PNG bytes as they are on disk now. */
    clientHash: string;
    /** What goes into the `meta` field: the capture JSON minus `capturedAt` / `fullPage`. */
    meta: ScreenshotMeta;
}

export interface ReadCapturesResult {
    captures: LocalCapture[];
    /** Files that were skipped, with the reason. */
    skipped: string[];
    /** Non-fatal notes, e.g. a PNG that changed after capture. */
    notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function validRect(rect: unknown): boolean {
    if (!isRecord(rect)) {
        return false;
    }
    const { x, y, w, h } = rect;
    return [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) && (w as number) > 0 && (h as number) > 0;
}

/**
 * Drop the regions the server would refuse (no positive rect, text over the
 * limit) and cap their number, so one odd text node does not cost the screen.
 * Returns the kept regions and how many were dropped.
 */
export function sanitizeRegions(regions: unknown[]): { regions: unknown[]; dropped: number } {
    const kept = regions.filter(
        (region) => isRecord(region) && validRect(region.rect) && (region.text === undefined || (typeof region.text === "string" && region.text.length <= MAX_REGION_TEXT)),
    );
    const capped = kept.slice(0, MAX_REGIONS_PER_SCREEN);
    return { regions: capped, dropped: regions.length - capped.length };
}

/**
 * Read every capture pair in `dir`, sorted by file name. A JSON without a PNG, or
 * one that is not a capture, is skipped with a reason. The hash is always taken
 * from the PNG on disk, so an image edited after capture still dedupes correctly.
 */
export function readCaptures(dir: string): ReadCapturesResult {
    const abs = resolve(dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new UsageError(
            `Capture directory not found: ${dir}\n` +
                "Capture screens with @translatize/playwright first (it writes to .translatize/captures by default), or pass the directory.",
        );
    }
    const result: ReadCapturesResult = { captures: [], skipped: [], notes: [] };
    const jsonFiles = readdirSync(abs)
        .filter((name) => name.endsWith(".json"))
        .sort();
    for (const file of jsonFiles) {
        const slug = basename(file, ".json");
        const jsonPath = join(abs, file);
        const pngPath = join(abs, `${slug}.png`);

        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(jsonPath, "utf8"));
        } catch (err) {
            result.skipped.push(`${file}: not valid JSON – ${(err as Error).message}`);
            continue;
        }
        if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "") {
            result.skipped.push(`${file}: not a capture file (no "name")`);
            continue;
        }
        if (raw.regions !== undefined && !Array.isArray(raw.regions)) {
            result.skipped.push(`${file}: "regions" must be an array`);
            continue;
        }
        if (!existsSync(pngPath)) {
            result.skipped.push(`${file}: no matching ${slug}.png`);
            continue;
        }

        const clientHash = sha256Hex(readFileSync(pngPath));
        if (typeof raw.clientHash === "string" && raw.clientHash !== clientHash) {
            result.notes.push(`${slug}.png changed after capture – using the hash of the file on disk`);
        }
        // The contract: send the capture JSON as-is, minus the two local-only fields.
        const { capturedAt: _capturedAt, fullPage: _fullPage, locale, ...rest } = raw;
        const { regions, dropped } = sanitizeRegions(Array.isArray(raw.regions) ? raw.regions : []);
        if (dropped > 0) {
            result.notes.push(`${file}: left out ${dropped} region(s) the server would refuse (empty box, text over ${MAX_REGION_TEXT} characters, or over ${MAX_REGIONS_PER_SCREEN} regions)`);
        }
        const keepLocale = typeof locale === "string" && LOCALE_RE.test(locale.trim());
        if (locale !== undefined && !keepLocale) {
            result.notes.push(`${file}: locale ${JSON.stringify(locale)} is not a language tag – sent without it`);
        }
        const meta = { ...rest, ...(keepLocale ? { locale: (locale as string).trim() } : {}), regions, clientHash } as unknown as ScreenshotMeta;
        result.captures.push({ slug, pngPath, clientHash, meta });
    }
    return result;
}

/** Stop before creating a run the server would refuse to fill. */
export function assertWithinRunLimit(count: number, dir: string): void {
    if (count > MAX_SCREENS_PER_RUN) {
        throw new UsageError(
            `Found ${count} captures in ${dir}, but a capture run holds at most ${MAX_SCREENS_PER_RUN} screens. ` +
                "Split them into several directories (for example one per test project) and upload each one separately.",
        );
    }
}

/** The client calls an upload makes – a seam for tests. */
export type ScreenshotClient = Pick<
    TranslatizeClient,
    "createScreenshotRun" | "checkScreenshots" | "uploadScreenshot" | "completeScreenshotRun"
>;

export interface UploadOptions {
    branch?: string;
    runName: string;
    commitSha?: string;
    /** Reads a PNG when it has to be sent. Defaults to reading the file. */
    readImage?: (path: string) => Uint8Array;
    /** Waits before a retry when the server is busy. Defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;
}

export interface UploadResult {
    runId: string;
    total: number;
    /** Screens sent with their image. */
    uploaded: number;
    /** Screens sent as meta only, because the server already had the image. */
    reused: number;
    /** Screens the server matched to an image it already stored. */
    deduped: number;
    failed: { name: string; error: string }[];
    /** Set when an error stopped the upload part-way (quota, run limit…). */
    stopped: TranslatizeApiError | null;
    run: CompleteScreenshotRunResult["run"] | null;
}

// Errors after which every further screen would fail too.
const STOP_CODES = new Set([
    "screenshot_quota_exceeded",
    "run_screen_limit",
    "run_not_open",
    "run_not_found",
    "branch_not_allowed",
    "feature_not_available",
    "feature_disabled",
    "image_processing_unavailable",
    "insufficient_permissions",
    "access_denied",
    "token_expired",
    "token_inactive",
    "ip_not_allowed",
    "project_mismatch",
    "project_not_found",
]);
// After these the run cannot be completed either.
const NO_COMPLETE_CODES = new Set(["run_not_open", "run_not_found"]);

const isBusy = (err: unknown): boolean => err instanceof TranslatizeApiError && err.code === "screenshot_pipeline_busy";

/**
 * Create a run, ask which images the server has, upload the rest (meta for every
 * screen), then complete the run. A per-screen failure is recorded and the upload
 * goes on; a quota or limit error stops it, and what was sent is still completed.
 */
export async function uploadCaptures(client: ScreenshotClient, captures: LocalCapture[], opts: UploadOptions): Promise<UploadResult> {
    const readImage = opts.readImage ?? ((path: string) => readFileSync(path));
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const upload = async (runId: string, input: Parameters<ScreenshotClient["uploadScreenshot"]>[1]): Promise<ScreenshotUploadResult> => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await client.uploadScreenshot(runId, input);
            } catch (err) {
                if (!isBusy(err) || attempt >= BUSY_RETRIES) {
                    throw err;
                }
                await sleep(BUSY_WAIT_MS * (attempt + 1));
            }
        }
    };
    const { runId } = await client.createScreenshotRun({
        name: opts.runName,
        ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
        ...(opts.commitSha !== undefined ? { commitSha: opts.commitSha } : {}),
    });

    const hashes = [...new Set(captures.map((capture) => capture.clientHash))];
    const known = new Set((await client.checkScreenshots(runId, hashes)).existing);

    const result: UploadResult = { runId, total: captures.length, uploaded: 0, reused: 0, deduped: 0, failed: [], stopped: null, run: null };
    // Set on anything that is not a TranslatizeApiError (a network drop, a file
    // disappearing mid-upload, …) – rethrown below, but only after the finally
    // block below has had a chance to complete the run with whatever was already
    // sent. Without that, a crash here used to leave the run open on the server
    // until the GC's 24h timeout, and the screens it did receive would never run
    // through the server's own supersede logic.
    let unexpected: unknown = null;
    try {
        for (const capture of captures) {
            const reuse = known.has(capture.clientHash);
            try {
                let res: ScreenshotUploadResult;
                try {
                    res = await upload(runId, { meta: capture.meta, image: reuse ? undefined : readImage(capture.pngPath) });
                } catch (err) {
                    // The image may have been cleaned up between check and upload – send it after all.
                    if (reuse && err instanceof TranslatizeApiError && err.code === "image_required") {
                        res = await upload(runId, { meta: capture.meta, image: readImage(capture.pngPath) });
                        known.delete(capture.clientHash);
                    } else {
                        throw err;
                    }
                }
                if (known.has(capture.clientHash)) {
                    result.reused++;
                } else {
                    result.uploaded++;
                }
                if (res.deduped) {
                    result.deduped++;
                }
                // A second screen with the same pixels in this run needs no upload.
                known.add(capture.clientHash);
            } catch (err) {
                if (err instanceof TranslatizeApiError && STOP_CODES.has(err.code)) {
                    result.stopped = err;
                    break;
                }
                if (err instanceof TranslatizeApiError) {
                    result.failed.push({ name: capture.meta.name, error: describeApiError(err) });
                    continue;
                }
                unexpected = err;
                break;
            }
        }
    } finally {
        // A run that is gone or closed cannot be completed; everything else is –
        // including after an unexpected error, so what was already sent still
        // gets superseded/counted server-side instead of sitting in an open run.
        if (!(result.stopped && NO_COMPLETE_CODES.has(result.stopped.code))) {
            if (unexpected) {
                // The upload loop itself already failed and that error is what
                // gets rethrown below – a secondary failure completing the run
                // is swallowed so it doesn't hide the original crash.
                try {
                    result.run = (await client.completeScreenshotRun(runId)).run;
                } catch {
                    result.run = null;
                }
            } else {
                // Success path (or a stopped-but-completable run): a failure here
                // must not be swallowed, or CI would report ok while the run stays
                // open on the server. Let it propagate.
                result.run = (await client.completeScreenshotRun(runId)).run;
            }
        }
    }
    if (unexpected) {
        throw unexpected;
    }
    return result;
}

/** A default run name that says where it came from. */
export function defaultRunName(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
    const stamp = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const ref = env.GITHUB_REF_NAME || env.CI_COMMIT_REF_NAME;
    return ref ? `${ref} ${stamp}` : `capture ${stamp}`;
}

/** `--commit-sha`, else the CI's commit (GitHub Actions, GitLab CI). */
export function resolveCommitSha(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const value = (flag ?? "").trim() || (env.GITHUB_SHA ?? "").trim() || (env.CI_COMMIT_SHA ?? "").trim();
    return value || undefined;
}

/** `translatize screenshots upload [dir]` – send Playwright captures to Translatize. */
export async function screenshotsUploadCommand(dir: string | undefined, opts: ScreenshotsUploadOpts): Promise<number> {
    const colors = createColors();
    const captureDir = dir && dir.trim() !== "" ? dir : DEFAULT_CAPTURE_DIR;
    const local = readCaptures(captureDir);
    for (const line of local.skipped) {
        warn(colors, `skipped ${line}`);
    }
    for (const line of local.notes) {
        warn(colors, line);
    }
    if (local.captures.length === 0) {
        throw new UsageError(`No captures found in ${captureDir} (expected <name>.json + <name>.png pairs from @translatize/playwright).`);
    }
    assertWithinRunLimit(local.captures.length, captureDir);

    const ctx = buildApiContext(opts);
    const runName = (opts.runName ?? "").trim() || defaultRunName();
    const result = await uploadCaptures(ctx.client, local.captures, {
        branch: ctx.branch,
        runName,
        commitSha: resolveCommitSha(opts.commitSha),
    });
    const failed = result.failed.length > 0 || result.stopped !== null;

    if (opts.json) {
        printJson({
            command: "screenshots upload",
            runId: result.runId,
            runName,
            total: result.total,
            uploaded: result.uploaded,
            reused: result.reused,
            deduped: result.deduped,
            skipped: local.skipped,
            failed: result.failed,
            stopped: result.stopped ? { code: result.stopped.code, message: describeApiError(result.stopped) } : null,
            run: result.run,
            ok: !failed,
        });
        return failed ? 1 : 0;
    }
    renderUpload(colors, runName, result, local.skipped.length);
    return failed ? 1 : 0;
}

function renderUpload(colors: Colors, runName: string, result: UploadResult, skipped: number): void {
    const sent = result.uploaded + result.reused;
    info(`Capture run "${colors.bold(runName)}" – ${sent} of ${result.total} screen(s) sent`);
    info(
        `  ${colors.green(`${result.uploaded} image(s) uploaded`)}, ${colors.dim(`${result.reused} already on the server`)}` +
            (skipped > 0 ? `, ${colors.yellow(`${skipped} skipped`)}` : "") +
            (result.failed.length > 0 ? `, ${colors.red(`${result.failed.length} failed`)}` : ""),
    );
    if (result.run) {
        const c = result.run.counts;
        info(`  run ${result.run.status}: ${c.screens} screen(s), ${c.linked} key link(s), ${c.ambiguous} ambiguous, ${c.superseded} superseded`);
    }
    if (result.failed.length > 0) {
        info("");
        info(colors.red("Failed:"));
        for (const failure of result.failed) {
            info(`  ${failure.name}: ${failure.error}`);
        }
    }
    if (result.stopped) {
        info("");
        info(colors.red("Stopped: ") + describeApiError(result.stopped));
    }
}
