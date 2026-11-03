import { memoryStorage, type StorageAdapter } from "./storage.js";

export type Translations = Record<string, unknown>;

export interface OtaClientOptions {
    distributionId: string;
    cdnUrl?: string;
    storage?: StorageAdapter;
    /** Translations shipped with the app, per language. Used until the first download. */
    bundled?: Record<string, Translations>;
    /** Cached data younger than this is not re-checked. Default 5 minutes. */
    minRefreshMs?: number;
    /** Per-request timeout. Default 3 seconds. */
    timeoutMs?: number;
    fetch?: typeof fetch;
    /** Clock, for tests. */
    now?: () => number;
}

export interface OtaClient {
    /**
     * Resolves at once with cached ?? bundled and refreshes in the background when stale.
     * Only when neither exists does it wait for one fetch attempt; if that fails too it resolves with {}.
     */
    load(lang: string): Promise<Translations>;
    /** Called when a background or manual refresh stored new data. Returns an unsubscribe function. */
    onUpdate(cb: (lang: string, translations: Translations) => void): () => void;
    /** Check the manifest now. Resolves with the new translations, or null when nothing changed or the attempt failed. */
    refresh(lang: string): Promise<Translations | null>;
}

interface CacheEntry {
    data: Translations;
    hash: string;
    fetchedAt: number;
}

interface Manifest {
    languages?: Record<string, { url?: string; hash?: string; bytes?: number }>;
}

const DEFAULT_BACKOFF_MS = 3_600_000;
const MAX_BACKOFF_MS = 86_400_000;

async function sha256Hex(text: string): Promise<string | null> {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function retryAfterMs(header: string | null, now: number): number {
    if (!header) return DEFAULT_BACKOFF_MS;
    const secs = Number(header);
    let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
    if (!Number.isFinite(ms) || ms <= 0) ms = DEFAULT_BACKOFF_MS;
    return Math.min(ms, MAX_BACKOFF_MS);
}

class RateLimited extends Error {
    constructor(public waitMs: number) {
        super("rate limited");
    }
}

export function createOtaClient(options: OtaClientOptions): OtaClient {
    const id = options.distributionId;
    if (!id) throw new Error("distributionId is required");
    const cdn = (options.cdnUrl ?? "https://cdn.translatize.com").replace(/\/+$/, "");
    const storage = options.storage ?? memoryStorage();
    const minRefreshMs = options.minRefreshMs ?? 300_000;
    const timeoutMs = options.timeoutMs ?? 3_000;
    const now = options.now ?? Date.now;
    const doFetch = (options.fetch ?? ((...a) => globalThis.fetch(...a))) as typeof fetch;

    const listeners = new Set<(lang: string, t: Translations) => void>();
    const inflight = new Map<string, Promise<Translations | null>>();
    let blockedUntil = 0;

    const cacheKey = (lang: string) => `${id}:${lang}`;

    async function readCache(lang: string): Promise<CacheEntry | null> {
        try {
            const raw = await storage.getItem(cacheKey(lang));
            if (!raw) return null;
            const e = JSON.parse(raw) as CacheEntry;
            if (e && typeof e === "object" && e.data && typeof e.data === "object") return e;
        } catch {
            /* corrupt cache is treated as empty */
        }
        return null;
    }

    async function writeCache(lang: string, entry: CacheEntry): Promise<void> {
        try {
            await storage.setItem(cacheKey(lang), JSON.stringify(entry));
        } catch {
            /* storage full or unavailable – still serve from memory next time */
        }
    }

    async function get(path: string): Promise<Response> {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            // no cookies, no custom headers: keeps it a simple CORS request
            const res = await doFetch(cdn + path, { credentials: "omit", signal: ctrl.signal });
            if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get("retry-after"), now()));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } finally {
            clearTimeout(timer);
        }
    }

    async function doRefresh(lang: string): Promise<Translations | null> {
        if (now() < blockedUntil) return null;
        try {
            const manifest = (await (await get(`/d/${id}/manifest.json`)).json()) as Manifest;
            const entry = manifest.languages?.[lang];
            if (!entry || typeof entry.url !== "string" || typeof entry.hash !== "string") return null;
            // the url must stay inside this distribution
            if (!entry.url.startsWith(`/d/${id}/`) || entry.url.includes("..")) return null;

            const cached = await readCache(lang);
            if (cached && cached.hash === entry.hash) {
                await writeCache(lang, { ...cached, fetchedAt: now() });
                return null;
            }

            const body = await (await get(entry.url)).text();
            const actual = await sha256Hex(body);
            if (actual !== null && actual !== entry.hash.toLowerCase()) return null;
            const data = JSON.parse(body) as Translations;
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;

            await writeCache(lang, { data, hash: entry.hash, fetchedAt: now() });
            for (const cb of [...listeners]) {
                try {
                    cb(lang, data);
                } catch {
                    /* a bad listener must not break the others */
                }
            }
            return data;
        } catch (err) {
            if (err instanceof RateLimited) blockedUntil = now() + err.waitMs;
            return null;
        }
    }

    function refresh(lang: string): Promise<Translations | null> {
        let p = inflight.get(lang);
        if (!p) {
            p = doRefresh(lang).finally(() => inflight.delete(lang));
            inflight.set(lang, p);
        }
        return p;
    }

    return {
        async load(lang) {
            const cached = await readCache(lang);
            const local = cached?.data ?? options.bundled?.[lang];
            if (local) {
                if (!cached || now() - cached.fetchedAt >= minRefreshMs) void refresh(lang);
                return local;
            }
            return (await refresh(lang)) ?? {};
        },
        onUpdate(cb) {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        refresh,
    };
}
