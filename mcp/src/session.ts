import type { MeResponse, TranslatizeClient } from "@translatize/core";

/**
 * Wraps a {@link TranslatizeClient} and caches the token's identity (`/me`) for the
 * process lifetime. The result is resolved lazily on the first tool call that needs it,
 * so the server can start and answer `initialize` / `tools/list` without any network I/O.
 * A failed lookup is not cached, so a transient failure can be retried on the next call.
 */
export class Session {
    private meCache?: MeResponse;
    private meInFlight?: Promise<MeResponse>;

    /**
     * @param client API client bound to one project/branch.
     * @param appUrl Base URL of the Translatize web app (no trailing slash), used to build
     *   human-facing `platformUrl` review links.
     */
    constructor(
        public readonly client: TranslatizeClient,
        public readonly appUrl: string,
    ) {}

    /** The token's project, bound branch, role and metadata — fetched once, then memoized. */
    async me(): Promise<MeResponse> {
        if (this.meCache !== undefined) {
            return this.meCache;
        }
        if (this.meInFlight === undefined) {
            this.meInFlight = this.client.me().then(
                (result) => {
                    this.meCache = result;
                    this.meInFlight = undefined;
                    return result;
                },
                (err) => {
                    this.meInFlight = undefined;
                    throw err;
                },
            );
        }
        return this.meInFlight;
    }
}
