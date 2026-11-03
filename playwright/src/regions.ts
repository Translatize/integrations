import { decodeMarkers } from "./markers.js";

export type Attr = "placeholder" | "title" | "aria-label" | "alt";
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface RawRegion {
    text: string;
    attr?: Attr;
    rect: Rect;
}
export interface Region {
    text?: string;
    marker?: string;
    attr?: Attr;
    rect: Rect;
}
export interface CaptureJson {
    name: string;
    viewport: { width: number; height: number };
    locale?: string;
    clientHash: string;
    fullPage: boolean;
    capturedAt: string;
    regions: Region[];
}

/** Safe single filename: no separators, no leading dots, lowercase. */
export function slugify(name: string): string {
    const s = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/\.{2,}/g, ".")
        .replace(/^[-.]+|[-.]+$/g, "")
        .slice(0, 100)
        .replace(/[-.]+$/g, "");
    return s || "capture";
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Turns raw browser rects into contract regions: markers decoded, text trimmed, rects moved to
 * image coordinates (fullPage adds the scroll offset), empty and duplicate regions dropped.
 */
export function buildRegions(
    raw: RawRegion[],
    opts: { fullPage: boolean; scrollX?: number; scrollY?: number },
): Region[] {
    const dx = opts.fullPage ? (opts.scrollX ?? 0) : 0;
    const dy = opts.fullPage ? (opts.scrollY ?? 0) : 0;
    const out: Region[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
        if (!(r.rect.w > 0) || !(r.rect.h > 0)) continue;
        const { text, markers } = decodeMarkers(r.text);
        const clean = text.replace(/\s+/g, " ").trim();
        const marker = markers[0];
        if (!clean && !marker) continue;
        const rect = { x: round(r.rect.x + dx), y: round(r.rect.y + dy), w: round(r.rect.w), h: round(r.rect.h) };
        // the server refuses boxes that round down to nothing
        if (!(rect.w > 0) || !(rect.h > 0)) continue;
        const dedupe = `${clean}|${marker ?? ""}|${rect.x},${rect.y},${rect.w},${rect.h}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        // key order text, marker, attr, rect – the capture JSON's documented order
        const region = {} as Region;
        if (clean) region.text = clean;
        if (marker) region.marker = marker;
        if (r.attr) region.attr = r.attr;
        region.rect = rect;
        out.push(region);
    }
    return out;
}

export function buildCaptureJson(input: CaptureJson): CaptureJson {
    // fixed key order, locale only when known
    return {
        name: input.name,
        viewport: input.viewport,
        ...(input.locale ? { locale: input.locale } : {}),
        clientHash: input.clientHash,
        fullPage: input.fullPage,
        capturedAt: input.capturedAt,
        regions: input.regions,
    };
}
