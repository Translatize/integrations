import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { collectInPage } from "./collect.js";
import { buildCaptureJson, buildRegions, slugify, type CaptureJson } from "./regions.js";

export interface CaptureOptions {
    fullPage?: boolean;
    mask?: Locator[];
    locale?: string;
    /** Default ".translatize/captures". */
    outDir?: string;
}

export interface CaptureResult {
    pngPath: string;
    jsonPath: string;
    capture: CaptureJson;
}

const FREEZE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

/** Takes a screenshot and writes <outDir>/<slug>.png + .json. Makes no network calls. */
export async function capture(page: Page, name: string, options: CaptureOptions = {}): Promise<CaptureResult> {
    const fullPage = options.fullPage ?? false;
    const outDir = options.outDir ?? ".translatize/captures";
    const slug = slugify(name);

    // A page whose CSP blocks inline styles refuses this; screenshot() below still
    // disables animations and hides the caret, so go on without it.
    const style = await page.addStyleTag({ content: FREEZE_CSS }).catch(() => null);
    try {
        await page.evaluate(() => document.fonts?.ready.then(() => undefined));
        const collected = await page.evaluate(collectInPage, { fullPage });
        const png = await page.screenshot({
            fullPage,
            mask: options.mask,
            animations: "disabled",
            caret: "hide",
            type: "png",
        });

        const viewport =
            page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
        const locale =
            options.locale ?? (await page.evaluate(() => document.documentElement.lang || undefined)) ?? undefined;

        const json = buildCaptureJson({
            name,
            viewport,
            locale,
            clientHash: createHash("sha256").update(png).digest("hex"),
            fullPage,
            capturedAt: new Date().toISOString(),
            regions: buildRegions(collected.regions, {
                fullPage,
                scrollX: collected.scrollX,
                scrollY: collected.scrollY,
            }),
        });

        await mkdir(outDir, { recursive: true });
        const pngPath = path.join(outDir, `${slug}.png`);
        const jsonPath = path.join(outDir, `${slug}.json`);
        await writeFile(pngPath, png);
        await writeFile(jsonPath, JSON.stringify(json, null, 2) + "\n");
        return { pngPath, jsonPath, capture: json };
    } finally {
        // addStyleTag types the handle as Node, which has no remove()
        if (style) await style.evaluate((el: Element) => el.remove()).catch(() => undefined);
    }
}
