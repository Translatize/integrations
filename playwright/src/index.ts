import { test as base, type Page } from "@playwright/test";
import { capture, type CaptureOptions, type CaptureResult } from "./capture.js";

export { capture } from "./capture.js";
export type { CaptureOptions, CaptureResult } from "./capture.js";
export { slugify, buildRegions, buildCaptureJson } from "./regions.js";
export type { CaptureJson, Region, RawRegion, Rect, Attr } from "./regions.js";
export { markerHash, wrapWithMarker, decodeMarkers, stripMarkers, postProcessor } from "./markers.js";

export interface TranslatizeFixture {
    capture(name: string, options?: CaptureOptions): Promise<CaptureResult>;
}

/** Fixture function: `base.extend<{ translatize: TranslatizeFixture }>({ translatize })`. */
export const translatize = async (
    { page }: { page: Page },
    use: (fixture: TranslatizeFixture) => Promise<void>,
): Promise<void> => {
    await use({ capture: (name, options) => capture(page, name, options) });
};

export const test = base.extend<{ translatize: TranslatizeFixture }>({ translatize });
