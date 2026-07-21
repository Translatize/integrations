import type {
    MeResponse,
    ListLabelsResponse,
    ListLabelsOptions,
    UpsertInput,
    UpsertLabelResult,
    UpsertOptions,
    BatchResult,
    ExportOptions,
    ListBranchesResponse,
    CreateBranchInput,
    CreateBranchResponse,
    CompareResponse,
    ConflictsResponse,
    MergeOptions,
    MergeResult,
    DeleteBranchResult,
    AutoTranslateOptions,
    AutoTranslateResult,
    TranslationStatusResponse,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT = "translatize-core/0.1.1";
// Server-enforced maximum labels per batch request; upsertLabels chunks to this.
const MAX_BATCH = 500;

export interface TranslatizeClientOptions {
    /** Base API URL including the version segment, e.g. `https://api.translatize.com/v1`. A trailing slash is tolerated. */
    apiUrl: string;
    /** Integration API token (the `mcni_...` string). */
    token: string;
    /** Per-request timeout in milliseconds. Defaults to 30000. */
    timeoutMs?: number;
}

/**
 * Thrown for any non-2xx API response, and for network/timeout failures.
 * `.code` is the API's `error` field when present, otherwise `http_<status>`,
 * `network_error`, or `timeout`.
 */
export class TranslatizeApiError extends Error {
    /** HTTP status code, or 0 for network/timeout failures. */
    readonly status: number;
    /** Machine-readable error code. */
    readonly code: string;
    /**
     * The parsed JSON error body when the server returned an object, otherwise
     * `undefined`. Carries error-specific context – e.g. `boundBranch` for
     * `branch_not_allowed`.
     */
    readonly details?: Record<string, unknown>;

    constructor(message: string, status: number, code: string, details?: Record<string, unknown>) {
        super(message);
        this.name = "TranslatizeApiError";
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

interface RequestOptions {
    query?: Record<string, string | undefined>;
    body?: unknown;
}

// Guard the branch-name path segment of the branch endpoints. A blank name would
// otherwise collapse the URL (e.g. `/branches//compare`) and hit the wrong route.
function requireBranchName(name: unknown, method: string): asserts name is string {
    if (typeof name !== "string" || name.trim() === "") {
        throw new Error(`${method}: a non-empty branch name is required`);
    }
}

/**
 * Thin client over the Translatize integration API. Authenticates with a machine
 * token bound to one project and one branch – the client discovers the project id
 * itself (via `me()`, cached), so project-scoped methods take no id.
 */
export class TranslatizeClient {
    private readonly apiUrl: string;
    private readonly token: string;
    private readonly timeoutMs: number;
    private projectIdCache?: string;

    constructor(opts: TranslatizeClientOptions) {
        if (!opts || typeof opts.apiUrl !== "string" || opts.apiUrl.trim() === "") {
            throw new Error("TranslatizeClient: `apiUrl` is required");
        }
        if (typeof opts.token !== "string" || opts.token.trim() === "") {
            throw new Error("TranslatizeClient: `token` is required");
        }
        // Tolerate a trailing slash so `.../v1` and `.../v1/` behave identically.
        this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
        this.token = opts.token;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /** Identity of the token: its project, bound branch, role, and token metadata. */
    async me(): Promise<MeResponse> {
        const res = await this.fetchOk("GET", "/integrations/me");
        return (await res.json()) as MeResponse;
    }

    /**
     * List labels on a branch, optionally filtered by namespace prefix and/or
     * status. Reads the token's bound branch unless `opts.branch` names another
     * allowed branch.
     */
    async listLabels(opts: ListLabelsOptions = {}): Promise<ListLabelsResponse> {
        const projectId = await this.resolveProjectId();
        const res = await this.fetchOk("GET", `/integrations/projects/${encodeURIComponent(projectId)}/labels`, {
            query: { namespace: opts.namespace, status: opts.status, branch: opts.branch },
        });
        return (await res.json()) as ListLabelsResponse;
    }

    /**
     * Export a branch as a raw file body in the requested format. Returns the file
     * contents verbatim. Exports the token's bound branch unless `opts.branch`
     * names another allowed branch.
     */
    async exportFile(opts: ExportOptions): Promise<string> {
        if (!opts || !opts.format) {
            throw new Error("exportFile: `format` is required");
        }
        const projectId = await this.resolveProjectId();
        const res = await this.fetchOk("GET", `/integrations/projects/${encodeURIComponent(projectId)}/export`, {
            query: { format: opts.format, lang: opts.lang, namespace: opts.namespace, branch: opts.branch },
        });
        return res.text();
    }

    /**
     * Create or update a single label (upsert). Writes the token's bound branch
     * unless `opts.branch` names another allowed branch.
     */
    async upsertLabel(input: UpsertInput, opts: UpsertOptions = {}): Promise<UpsertLabelResult> {
        const projectId = await this.resolveProjectId();
        const body = opts.branch !== undefined ? { ...input, branch: opts.branch } : input;
        const res = await this.fetchOk("PATCH", `/integrations/projects/${encodeURIComponent(projectId)}/labels`, {
            body,
        });
        return (await res.json()) as UpsertLabelResult;
    }

    /**
     * Create or update many labels, transparently chunking into server-sized
     * batches (max 500 each) and aggregating the per-batch `{updated, created, failed}`.
     * All chunks target the same branch: the token's bound branch unless
     * `opts.branch` names another allowed branch.
     */
    async upsertLabels(labels: UpsertInput[], opts: UpsertOptions = {}): Promise<BatchResult> {
        const aggregate: BatchResult = { updated: 0, created: 0, failed: [] };
        if (!Array.isArray(labels) || labels.length === 0) {
            return aggregate;
        }
        const projectId = await this.resolveProjectId();
        const path = `/integrations/projects/${encodeURIComponent(projectId)}/labels/batch`;

        for (let i = 0; i < labels.length; i += MAX_BATCH) {
            const chunk = labels.slice(i, i + MAX_BATCH);
            const body: Record<string, unknown> = { labels: chunk };
            if (opts.branch !== undefined) {
                body.branch = opts.branch;
            }
            const res = await this.fetchOk("PATCH", path, { body });
            const data = (await res.json()) as BatchResult;
            aggregate.updated += data.updated ?? 0;
            aggregate.created += data.created ?? 0;
            if (Array.isArray(data.failed)) {
                aggregate.failed.push(...data.failed);
            }
        }
        return aggregate;
    }

    /**
     * List every branch in the project. Each entry is flagged with
     * `createdByThisToken` and `writable` (whether the branch is in the token's
     * allowed set). `baseBranch` is the token's bound branch; `branchScope` is
     * `fixed` or `create-own`.
     */
    async listBranches(): Promise<ListBranchesResponse> {
        const projectId = await this.resolveProjectId();
        const res = await this.fetchOk("GET", `/integrations/projects/${encodeURIComponent(projectId)}/branches`);
        return (await res.json()) as ListBranchesResponse;
    }

    /**
     * Create a branch based on the token's bound branch. Requires a `create-own`
     * token with the developer role or higher; the base branch is always the
     * token's bound branch and cannot be chosen.
     */
    async createBranch(input: CreateBranchInput): Promise<CreateBranchResponse> {
        if (!input || typeof input.name !== "string" || input.name.trim() === "") {
            throw new Error("createBranch: `name` is required");
        }
        const projectId = await this.resolveProjectId();
        const body: Record<string, unknown> = { name: input.name };
        if (input.description !== undefined) {
            body.description = input.description;
        }
        const res = await this.fetchOk("POST", `/integrations/projects/${encodeURIComponent(projectId)}/branches`, { body });
        return (await res.json()) as CreateBranchResponse;
    }

    /** Compare a branch (source) against the token's base branch (target). */
    async compareBranch(branch: string): Promise<CompareResponse> {
        requireBranchName(branch, "compareBranch");
        const projectId = await this.resolveProjectId();
        const res = await this.fetchOk(
            "GET",
            `/integrations/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}/compare`,
        );
        return (await res.json()) as CompareResponse;
    }

    /** List the flat merge conflicts of a branch (source) against the token's base branch (target). */
    async branchConflicts(branch: string): Promise<ConflictsResponse> {
        requireBranchName(branch, "branchConflicts");
        const projectId = await this.resolveProjectId();
        const res = await this.fetchOk(
            "GET",
            `/integrations/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}/conflicts`,
        );
        return (await res.json()) as ConflictsResponse;
    }

    /**
     * Merge a branch this token created back into the token's base branch (the
     * implicit, only-allowed target). Requires the developer role or higher. The
     * source branch is not deleted.
     */
    async mergeBranch(branch: string, opts: MergeOptions = {}): Promise<MergeResult> {
        requireBranchName(branch, "mergeBranch");
        const projectId = await this.resolveProjectId();
        const body: Record<string, unknown> = {};
        if (opts.strategy !== undefined) {
            body.strategy = opts.strategy;
        }
        if (opts.conflicts !== undefined) {
            body.conflicts = opts.conflicts;
        }
        const res = await this.fetchOk(
            "POST",
            `/integrations/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}/merge`,
            { body },
        );
        return (await res.json()) as MergeResult;
    }

    /**
     * Delete a branch this token created. Requires the developer role or higher.
     * `main` (and any branch the token did not create) can never be deleted.
     */
    async deleteBranch(branch: string): Promise<DeleteBranchResult> {
        requireBranchName(branch, "deleteBranch");
        const projectId = await this.resolveProjectId();
        const res = await this.fetchOk(
            "DELETE",
            `/integrations/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}`,
        );
        return (await res.json()) as DeleteBranchResult;
    }

    /**
     * Launch a background AI auto-translation job. Resolves either to a started
     * job (`started: true`) or a no-op (`started: false, nothingToTranslate: true`).
     * Translates the token's bound branch unless `opts.branch` names another
     * allowed branch.
     */
    async autoTranslate(opts: AutoTranslateOptions): Promise<AutoTranslateResult> {
        if (!opts || !Array.isArray(opts.targetLangs) || opts.targetLangs.length === 0) {
            throw new Error("autoTranslate: `targetLangs` must be a non-empty array");
        }
        const projectId = await this.resolveProjectId();
        const body: Record<string, unknown> = { targetLangs: opts.targetLangs };
        if (opts.branch !== undefined) {
            body.branch = opts.branch;
        }
        if (opts.sourceLang !== undefined) {
            body.sourceLang = opts.sourceLang;
        }
        if (opts.labelKeys !== undefined) {
            body.labelKeys = opts.labelKeys;
        }
        if (opts.overwriteTranslated !== undefined) {
            body.overwriteTranslated = opts.overwriteTranslated;
        }
        const res = await this.fetchOk(
            "POST",
            `/integrations/projects/${encodeURIComponent(projectId)}/translation/auto-translate`,
            { body },
        );
        return (await res.json()) as AutoTranslateResult;
    }

    /** The project's current/most-recent translation job state and the AI quota. */
    async translationStatus(): Promise<TranslationStatusResponse> {
        const projectId = await this.resolveProjectId();
        const res = await this.fetchOk(
            "GET",
            `/integrations/projects/${encodeURIComponent(projectId)}/translation/status`,
        );
        return (await res.json()) as TranslationStatusResponse;
    }

    // The token is bound to exactly one project; discover and cache its id via me().
    private async resolveProjectId(): Promise<string> {
        if (this.projectIdCache === undefined) {
            const me = await this.me();
            this.projectIdCache = me.project.id;
        }
        return this.projectIdCache;
    }

    private buildUrl(path: string, query?: Record<string, string | undefined>): string {
        let url = `${this.apiUrl}${path}`;
        if (query) {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== null && value !== "") {
                    params.append(key, value);
                }
            }
            const qs = params.toString();
            if (qs !== "") {
                url += `?${qs}`;
            }
        }
        return url;
    }

    private async fetchOk(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
        const url = this.buildUrl(path, options.query);
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.token}`,
            "User-Agent": USER_AGENT,
            Accept: "application/json",
        };

        let body: string | undefined;
        if (options.body !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(options.body);
        }

        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            const e = err as { name?: string; message?: string };
            if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
                throw new TranslatizeApiError(`Request to ${path} timed out after ${this.timeoutMs}ms`, 0, "timeout");
            }
            throw new TranslatizeApiError(e?.message || `Network request to ${path} failed`, 0, "network_error");
        }

        if (!response.ok) {
            throw await this.toApiError(response);
        }
        return response;
    }

    private async toApiError(response: Response): Promise<TranslatizeApiError> {
        let code = `http_${response.status}`;
        let message = response.statusText || code;
        let details: Record<string, unknown> | undefined;
        try {
            const data = (await response.json()) as { error?: unknown; message?: unknown };
            if (data !== null && typeof data === "object" && !Array.isArray(data)) {
                details = data as Record<string, unknown>;
            }
            if (data && typeof data.error === "string" && data.error !== "") {
                code = data.error;
                message = typeof data.message === "string" && data.message !== "" ? data.message : data.error;
            }
        } catch {
            // Non-JSON error body – keep the http_<status> fallback.
        }
        return new TranslatizeApiError(message, response.status, code, details);
    }
}
