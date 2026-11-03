# @translatize/ota

Zero-dependency client for Translatize over-the-air delivery. Ship translation
fixes without a new app release. Works in browsers, React Native and Node 18+.

> **Anything you publish is public – never put secrets in translations.**

## Install

```bash
npm install @translatize/ota
```

## Usage

```ts
import { createOtaClient, localStorageAdapter } from "@translatize/ota";
import en from "./locales/en.json";

const ota = createOtaClient({
    distributionId: "YOUR_DISTRIBUTION_ID",
    storage: localStorageAdapter(),
    bundled: { en },
});

const translations = await ota.load("en"); // cached ?? bundled, returns at once
const off = ota.onUpdate((lang, next) => render(lang, next)); // fires after a background refresh
```

Options: `distributionId`, `cdnUrl` (default `https://cdn.translatize.com`), `storage`,
`bundled`, `minRefreshMs` (default 300000), `timeoutMs` (default 3000), `fetch`.

`load(lang)` resolves immediately with the cached copy, else the bundled copy, and
refreshes in the background when the cache is older than `minRefreshMs`. It never
returns undefined. If you have neither a cache nor a bundle, `load` waits for one
fetch attempt and resolves with `{}` if that fails too – so bundle your default
language. `refresh(lang)` forces a check and resolves with the new data, or `null`
when nothing changed or the attempt failed.

On any network error, timeout, bad hash or a 429 the cached or bundled data stays.
After a 429 the client stops calling the CDN until `Retry-After` has passed.

## Storage

- `localStorageAdapter(prefix?)` – browsers (falls back to memory when blocked)
- `asyncStorageAdapter(AsyncStorage, prefix?)` – React Native
- default: in memory

Any object with `getItem(key)` and `setItem(key, value)` (sync or async) works.

## React Native

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createOtaClient, asyncStorageAdapter } from "@translatize/ota";

const ota = createOtaClient({
    distributionId: "YOUR_DISTRIBUTION_ID",
    storage: asyncStorageAdapter(AsyncStorage),
    bundled: { en: require("./locales/en.json") },
});
```

## i18next

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { OtaBackend } from "@translatize/ota/i18next";

i18n.use(OtaBackend).use(initReactI18next).init({
    lng: "en",
    backend: { distributionId: "YOUR_DISTRIBUTION_ID", bundled: { en } },
});
```

The distribution fills one namespace (`translation` by default, set `backend.namespace`
to change it); other namespaces load empty. Updates from a background refresh are
added to the running i18n instance; with react-i18next, set `react: { bindI18nStore: "added" }`
in the init options so components re-render when they arrive. JSON-nested distributions work as they are. For
a `json-flat` distribution (`"a.b": "x"`) set `keySeparator: false` in the i18next
options so the dotted keys are looked up as they are.

## Raw HTTP format (native apps)

Everything is plain GET over HTTPS, no auth and no cookies.

1. Manifest: `GET {cdn}/d/{distributionId}/manifest.json`

   ```json
   {
       "version": 3,
       "publishedAt": "2026-10-27T09:00:00Z",
       "languages": {
           "de": { "url": "/d/{id}/v3/de.json", "hash": "<sha256 hex of the file>", "bytes": 1234 }
       }
   }
   ```

2. Language file: `GET {cdn}{url}` – the body is the distribution's format
   (`{ "a": { "b": "x" } }` nested or `{ "a.b": "x" }` flat). Download it only when
   `hash` differs from the one you stored; verify the sha256 if you can.

Caching: files are `public, max-age=31536000, immutable` (the URL changes with every
release). The manifest is `public, max-age=60, stale-while-revalidate=300`; check it
at most every few minutes.

Errors: `404` – distribution unknown or disabled. `429` with `{"error":"quota_exceeded"}`
and `Retry-After` (seconds) – the quota is used up; keep showing your stored or bundled
strings and do not retry before `Retry-After`.
