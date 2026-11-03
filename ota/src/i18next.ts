import { createOtaClient, type OtaClient, type OtaClientOptions, type Translations } from "./client.js";

export interface OtaBackendOptions extends Partial<OtaClientOptions> {
    /** Reuse an existing client instead of building one from the other options. */
    client?: OtaClient;
    /** The only namespace the distribution fills. Default "translation". Others resolve to {}. */
    namespace?: string;
}

interface ResourceStoreLike {
    addResourceBundle(lng: string, ns: string, res: unknown, deep?: boolean, overwrite?: boolean): void;
}

type ReadCallback = (err: Error | null, data?: unknown) => void;

// createOtaClient throws when `distributionId` is missing/misconfigured. i18next
// calls init() synchronously (often from top-level app setup), so letting that
// throw propagate would take the whole app down over a config mistake, not just
// OTA. Serving whatever was bundled with the app is always the safer fallback.
function fallbackClient(bundled?: Record<string, Translations>): OtaClient {
    return {
        async load(lang) {
            return bundled?.[lang] ?? {};
        },
        onUpdate() {
            return () => {};
        },
        async refresh() {
            return null;
        },
    };
}

/** i18next backend: `i18n.use(OtaBackend).init({ backend: { distributionId: "..." } })`. */
export class OtaBackend {
    static type = "backend" as const;
    type = "backend" as const;
    private client: OtaClient | null = null;
    private ns = "translation";
    private unsubscribe: (() => void) | null = null;

    init(services: { resourceStore?: ResourceStoreLike } | null, backendOptions: OtaBackendOptions = {}) {
        this.ns = backendOptions.namespace ?? "translation";
        if (backendOptions.client) {
            this.client = backendOptions.client;
        } else {
            try {
                this.client = createOtaClient(backendOptions as OtaClientOptions);
            } catch (err) {
                console.warn(
                    `@translatize/ota: ${err instanceof Error ? err.message : String(err)} – serving bundled resources only`,
                );
                this.client = fallbackClient(backendOptions.bundled);
            }
        }
        this.unsubscribe?.();
        const store = services?.resourceStore;
        // fresh data from a background refresh lands in the running app
        this.unsubscribe = store
            ? this.client.onUpdate((lang, data) => store.addResourceBundle(lang, this.ns, data, true, true))
            : null;
    }

    read(language: string, namespace: string, callback: ReadCallback) {
        if (!this.client) return callback(new Error("OtaBackend.init was not called"));
        if (namespace !== this.ns) return callback(null, {});
        this.client.load(language).then(
            (data) => callback(null, data),
            (err) => callback(err instanceof Error ? err : new Error(String(err))),
        );
    }
}

export default OtaBackend;
