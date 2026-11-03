# @translatize/playwright

Capture screenshots of your app from Playwright tests, together with the position
of every piece of text on the page. `translatize screenshots upload` then sends the
results to Translatize, which links each region to its translation key so
translators see the string in context.

The capture step makes no network calls, so parallel workers are safe.

## Install

```bash
npm install --save-dev @translatize/playwright @playwright/test
```

## Usage

```ts
import { test } from "@translatize/playwright";

test("checkout", async ({ page, translatize }) => {
    await page.goto("/checkout");
    await translatize.capture("checkout", { fullPage: true });
});
```

Already have your own `test`? Add the fixture:

```ts
import { test as base } from "@playwright/test";
import { translatize } from "@translatize/playwright";

export const test = base.extend({ translatize });
```

Or call it directly: `await capture(page, "checkout", { mask: [page.locator(".avatar")] })`.

Options: `fullPage`, `mask` (Playwright locators painted over in the PNG), `locale`
(default: the page's `<html lang>`), `outDir` (default `.translatize/captures`).

It disables animations and transitions, hides the caret and waits for fonts. Then it
writes `<slug>.png` and `<slug>.json` to `outDir`. The slug comes from the name
(lowercase, no path separators).

The JSON holds `name`, `viewport`, `locale`, `clientHash` (sha256 of the PNG),
`fullPage`, `capturedAt` and `regions`: visible text nodes plus `placeholder`,
`title`, `aria-label` and `alt` attributes, each with a `rect` in CSS pixels of the
image. Hidden, zero-size and `aria-hidden` content is skipped.

Upload with the CLI:

```bash
translatize screenshots upload .translatize/captures
```

## Marker mode (exact linking)

Without markers the server matches the visible text to your strings, which can be
ambiguous when two keys have the same text. Markers remove the guesswork: in test
runs your app appends an invisible code to every translated string.

```ts
import i18next from "i18next";
import { postProcessor } from "@translatize/playwright/markers";

i18next.use(postProcessor).init({ postProcess: ["translatizeMarkers"] /* ... */ });
```

The post-processor only does something when `process.env.TRANSLATIZE_MARKERS === "1"`
(set it for the build under test) or the page URL has `?translatize-markers`. In
normal use strings are untouched. For other libraries call `wrapWithMarker(key, value)`
yourself.

`@translatize/playwright/markers` has no dependencies and runs in the browser.
Exports: `markerHash(key)` (first 10 hex chars of sha256 of the key),
`wrapWithMarker(key, value)`, `decodeMarkers(text)`, `stripMarkers(text)`,
`postProcessor`. The key is the flat key as stored in Translatize (for i18next the
namespace prefix is dropped). With i18next's `postProcessPassResolved: true` the key
that actually resolved is used, which keeps fallback keys (`t(["a", "b"])`) exact.
Keys must match Translatize as they are: if your Translatize keys carry the namespace
(`common.nav.home`) but the app calls `t("common:nav.home")`, the hashes differ and
those strings fall back to text matching.

Encoding: after the text come U+2060, then 40 characters (the 10 hex digits as 4 bits
each, U+200B for 0 and U+200C for 1), then U+2064. Anything shown to users in marker
runs carries these invisible characters, so never enable it in production.
