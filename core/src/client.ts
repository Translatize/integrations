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
    RebaseLabelsOptions,
    RebaseLabelsResult,
    AutoTranslateOptions,
    AutoTranslateResult,
    TranslationStatusResponse,
    GlossaryResponse,
    TmMatchesInput,
    TmMatchesResponse,
    RunQaOptions,
    QaRunResult,
    ListQaIssuesOptions,
    QaIssuesResponse,
    MergeGateOptions,
    MergeGateResponse,
    StartAiReviewOptions,
    AiReviewStarted,
    AiReviewStatusResponse,
    CreateScreenshotRunInput,
    ScreenshotRunCreated,
    ScreenshotCheckResult,
    UploadScreenshotInput,
    ScreenshotUploadResult,
    CompleteScreenshotRunResult,
    ListDistributionsResponse,
    PublishReleaseResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT = "translatize-core/0.2.0";
// Server-enforced maximum labels per batch request; upsertLabels chunks to this.
const MAX_BATCH = 500;
// Server limits per request for TM lookups and screenshot hash checks.
const MAX_TM_TEXTS = 100;
const MAX_CHECK_HASHES = 500;
// Headers the client owns; `headers` cannot replace them.
const RESERVED_HEADERS = new Set(["authorization", "content-type"]);

export interface TranslatizeClientOptions {
    /** Base API URL including the version segment, e.g. `https://api.translatize.com/v1`. A trailing slash is tolerated. */
    apiUrl: string;
    /** Integration API token (the `mcni_...` string). */
    token: string;
    /** Per-request timeout in milliseconds. Defaults to 30000. */
    timeoutMs?: number;
    /**
     * Extra headers sent on every request (e.g. `X-Internal-Token` for a trusted
     * service). They may replace `User-Agent` and `Accept`, never `Authorization`
     * or `Content-Type`.
     */
    headers?: Record<string, string>;
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
    /** A multipart body; fetch sets the boundary in Content-Type itself. */
    form?: FormData;
}

// Guard the branch-name path segment of the branch endpoints. A blank name would
// otherwise collapse the URL (e.g. `/branches//compare`) and hit the wrong route.
function requireBranchName(name: unknown, method: string): asserts name is string {
    if (typeof name !== "string" || name.trim() === "") {
        throw new Error(`${method}: a non-empty branch name is required`);
    }
}

// Same guard for the other id path segments (run ids, distribution ids).
function requireId(id: unknown, what: string, method: string): asserts id is string {
    if (typeof id !== "string" || id.trim() === "") {
        throw new Error(`${method}: a non-empty ${what} is required`);
    }
}

// The server's validation lists: `[{ field: "msg" }]` (core routes) or
// `[{ path, message }]` (module routes). Joined into one readable line.
function validationReasons(list: unknown): string {
    if (!Array.isArray(list)) {
        return "";
    }
    const parts: string[] = [];
    for (const item of list.slice(0, 5)) {
        if (item === null || typeof item !== "object") {
            continue;
        }
        const entry = item as Record<string, unknown>;
        if (typeof entry.message === "string") {
            parts.push(entry.message);
        } else {
            for (const value of Object.values(entry)) {
                if (typeof value === "string") {
                    parts.push(value);
                }
            }
        }
    }
    return parts.join("; ");
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
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
    private readonly extraHeaders: Record<string, string>;
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
        this.extraHeaders = {};
        for (const [name, value] of Object.entries(opts.headers ?? {})) {
            if (typeof value !== "string") {
                throw new Error(`TranslatizeClient: header "${name}" must be a string`);
            }
            if (RESERVED_HEADERS.has(name.toLowerCase())) {
                throw new Error(`TranslatizeClient: header "${name}" is set by the client and cannot be overridden`);
            }
            this.extraHeaders[name] = value;
        }
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
            query: {
                format: opts.format,
                lang: opts.lang,
                sourceLang: opts.sourceLang,
                namespace: opts.namespace,
                branch: opts.branch,
            },
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
     * Move `keys`' base (what the `branch-changes` merge strategy compares them
     * against) to their CURRENT text, without changing the text itself. Use this
     * after writing a branch's own copy of a language's base text – e.g. undoing a
     * key the branch changed and then changed back – so that language no longer
     * looks like a branch edit: without it, `branch-changes` would carry the
     * (already abandoned) text back over a later change to the base. Requires the
     * developer role or higher; `branch` must be one this token created. Keys not
     * found on the branch are reported in `notFound`, not thrown. Transparently
     * chunks `keys` into server-sized batches (max 500 each).
     *
     * `opts.langs` (at most 100 language codes) limits the move to those languages;
     * codes the project does not have are ignored, and when none is left nothing is
     * written (`rebased: 0`) – an empty list never means "all". Omit it to move every
     * language the label holds. A label that has no base yet (a branch created before
     * bases existed, or a label created on the branch) gets one: with `langs`, a base
     * of only those languages – its other languages keep counting as the branch's own
     * changes – unless it is still an untouched copy, which gets a full base, as it
     * does when `langs` is omitted.
     */
    async rebaseLabels(branch: string, keys: string[], opts: RebaseLabelsOptions = {}): Promise<RebaseLabelsResult> {
        requireBranchName(branch, "rebaseLabels");
        const aggregate: RebaseLabelsResult = { rebased: 0, notFound: [] };
        if (!Array.isArray(keys) || keys.length === 0) {
            return aggregate;
        }
        const projectId = await this.resolveProjectId();
        const path = `/integrations/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}/labels/rebase`;

        for (const batch of chunk(keys, MAX_BATCH)) {
            const body: Record<string, unknown> = { keys: batch };
            if (opts.langs !== undefined) {
                body.langs = opts.langs;
            }
            const res = await this.fetchOk("POST", path, { body });
            const data = (await res.json()) as RebaseLabelsResult;
            aggregate.rebased += data.rebased ?? 0;
            if (Array.isArray(data.notFound)) {
                aggregate.notFound.push(...data.notFound);
            }
        }
        return aggregate;
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

    // ------------------------------------------------------------------------
    // Glossary and translation memory
    // ------------------------------------------------------------------------

    /** The glossary terms that apply to the project (project terms plus its workspace's). */
    async getGlossary(): Promise<GlossaryResponse> {
        const res = await this.fetchOk("GET", await this.projectPath("/glossary"));
        return (await res.json()) as GlossaryResponse;
    }

    /**
     * Look up translation-memory matches (up to 3 per text, best first). Texts are
     * sent in chunks of 100 and the results come back in input order.
     */
    async findTranslationMemory(input: TmMatchesInput): Promise<TmMatchesResponse> {
        if (!input || !Array.isArray(input.texts)) {
            throw new Error("findTranslationMemory: `texts` must be an array");
        }
        if (!input.sourceLang || !input.targetLang) {
            throw new Error("findTranslationMemory: `sourceLang` and `targetLang` are required");
        }
        const out: TmMatchesResponse = { results: [] };
        if (input.texts.length === 0) {
            return out;
        }
        const path = await this.projectPath("/tm/matches");
        for (const texts of chunk(input.texts, MAX_TM_TEXTS)) {
            const body: Record<string, unknown> = { texts, sourceLang: input.sourceLang, targetLang: input.targetLang };
            if (input.threshold !== undefined) {
                body.threshold = input.threshold;
            }
            const res = await this.fetchOk("POST", path, { body });
            const data = (await res.json()) as TmMatchesResponse;
            if (Array.isArray(data.results)) {
                out.results.push(...data.results);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------------
    // QA and the merge gate
    // ------------------------------------------------------------------------

    /**
     * Run the rule-based QA checks on a branch (the base branch unless
     * `opts.branch` is given). Up to 20,000 pairs run inline; bigger runs answer
     * `{ background: true }` and continue on the server.
     */
    async runQa(opts: RunQaOptions = {}): Promise<QaRunResult> {
        const body: Record<string, unknown> = {};
        if (opts.branch !== undefined) {
            body.branch = opts.branch;
        }
        if (opts.keys !== undefined) {
            body.keys = opts.keys;
        }
        const res = await this.fetchOk("POST", await this.projectPath("/qa/run"), { body });
        return (await res.json()) as QaRunResult;
    }

    /** One page of the stored QA issues, with the per-severity counts. */
    async listQaIssues(opts: ListQaIssuesOptions = {}): Promise<QaIssuesResponse> {
        const res = await this.fetchOk("GET", await this.projectPath("/qa/issues"), {
            query: {
                branch: opts.branch,
                severity: opts.severity,
                key: opts.key,
                lang: opts.lang,
                source: opts.source,
                includeIgnored: opts.includeIgnored === true ? "true" : undefined,
                cursor: opts.cursor,
                limit: opts.limit !== undefined ? String(opts.limit) : undefined,
            },
        });
        return (await res.json()) as QaIssuesResponse;
    }

    /**
     * Preview the QA merge gate for merging `branch` into the token's base
     * branch with `opts.strategy` (default `overwrite`). `gate.blocked` means
     * `mergeBranch` with that strategy would fail with `qa_gate_blocked`.
     */
    async getMergeGate(branch: string, opts: MergeGateOptions = {}): Promise<MergeGateResponse> {
        requireBranchName(branch, "getMergeGate");
        const res = await this.fetchOk(
            "GET",
            await this.projectPath(`/branches/${encodeURIComponent(branch)}/merge-gate`),
            { query: { strategy: opts.strategy } },
        );
        return (await res.json()) as MergeGateResponse;
    }

    /** Queue an AI review of a branch's translations. Professional plan or higher; billed on its own quota. */
    async startAiReview(opts: StartAiReviewOptions = {}): Promise<AiReviewStarted> {
        const body: Record<string, unknown> = {};
        if (opts.branch !== undefined) {
            body.branch = opts.branch;
        }
        if (opts.keys !== undefined) {
            body.keys = opts.keys;
        }
        if (opts.langs !== undefined) {
            body.langs = opts.langs;
        }
        const res = await this.fetchOk("POST", await this.projectPath("/qa/ai-review"), { body });
        return (await res.json()) as AiReviewStarted;
    }

    /** The project's latest AI review job, or `{ job: null }`. */
    async aiReviewStatus(): Promise<AiReviewStatusResponse> {
        const res = await this.fetchOk("GET", await this.projectPath("/qa/ai-review/status"));
        return (await res.json()) as AiReviewStatusResponse;
    }

    // ------------------------------------------------------------------------
    // Screenshot capture runs
    // ------------------------------------------------------------------------

    /** Open a capture run. Needs the developer role and a plan with automated capture. */
    async createScreenshotRun(input: CreateScreenshotRunInput): Promise<ScreenshotRunCreated> {
        if (!input || typeof input.name !== "string" || input.name.trim() === "") {
            throw new Error("createScreenshotRun: `name` is required");
        }
        const body: Record<string, unknown> = { name: input.name };
        if (input.branch !== undefined) {
            body.branch = input.branch;
        }
        if (input.commitSha !== undefined) {
            body.commitSha = input.commitSha;
        }
        const res = await this.fetchOk("POST", await this.projectPath("/screenshots/runs"), { body });
        return (await res.json()) as ScreenshotRunCreated;
    }

    /**
     * Ask which images the server already holds, so they need not be uploaded
     * again. Hashes are sent in chunks of 500.
     */
    async checkScreenshots(runId: string, clientHashes: string[]): Promise<ScreenshotCheckResult> {
        requireId(runId, "run id", "checkScreenshots");
        const out: ScreenshotCheckResult = { existing: [] };
        if (!Array.isArray(clientHashes) || clientHashes.length === 0) {
            return out;
        }
        const path = await this.projectPath(`/screenshots/runs/${encodeURIComponent(runId)}/check`);
        for (const hashes of chunk(clientHashes, MAX_CHECK_HASHES)) {
            const res = await this.fetchOk("POST", path, { body: { clientHashes: hashes } });
            const data = (await res.json()) as ScreenshotCheckResult;
            if (Array.isArray(data.existing)) {
                out.existing.push(...data.existing);
            }
        }
        return out;
    }

    /**
     * Upload one screen of a run as multipart form data: `meta` (JSON) plus
     * `image` when given. Leave `image` out when `meta.clientHash` is one the
     * server already reported through {@link checkScreenshots}.
     */
    async uploadScreenshot(runId: string, input: UploadScreenshotInput): Promise<ScreenshotUploadResult> {
        requireId(runId, "run id", "uploadScreenshot");
        if (!input || !input.meta || typeof input.meta.name !== "string") {
            throw new Error("uploadScreenshot: `meta.name` is required");
        }
        const form = new FormData();
        form.append("meta", JSON.stringify(input.meta));
        if (input.image !== undefined) {
            // Copy into a plain ArrayBuffer-backed view, which every Blob implementation accepts.
            const bytes = new Uint8Array(input.image);
            form.append("image", new Blob([bytes], { type: input.contentType ?? "image/png" }), input.filename ?? "screen.png");
        }
        const res = await this.fetchOk(
            "POST",
            await this.projectPath(`/screenshots/runs/${encodeURIComponent(runId)}/screens`),
            { form },
        );
        return (await res.json()) as ScreenshotUploadResult;
    }

    /** Close a run: newer screens supersede older ones and the run counts are final. */
    async completeScreenshotRun(runId: string): Promise<CompleteScreenshotRunResult> {
        requireId(runId, "run id", "completeScreenshotRun");
        const res = await this.fetchOk(
            "POST",
            await this.projectPath(`/screenshots/runs/${encodeURIComponent(runId)}/complete`),
        );
        return (await res.json()) as CompleteScreenshotRunResult;
    }

    // ------------------------------------------------------------------------
    // OTA delivery
    // ------------------------------------------------------------------------

    /** The project's over-the-air delivery distributions whose branch this token may use. */
    async listDistributions(): Promise<ListDistributionsResponse> {
        const res = await this.fetchOk("GET", await this.projectPath("/ota/distributions"));
        return (await res.json()) as ListDistributionsResponse;
    }

    /**
     * Publish the distribution's branch as a new release on the CDN. Needs the
     * developer role, and the distribution's branch must be in the token's
     * allowed set. Everything published is public.
     */
    async publishRelease(distributionId: string): Promise<PublishReleaseResult> {
        requireId(distributionId, "distribution id", "publishRelease");
        const res = await this.fetchOk(
            "POST",
            await this.projectPath(`/ota/distributions/${encodeURIComponent(distributionId)}/releases`),
            { body: {} },
        );
        return (await res.json()) as PublishReleaseResult;
    }

    private async projectPath(suffix: string): Promise<string> {
        const projectId = await this.resolveProjectId();
        return `/integrations/projects/${encodeURIComponent(projectId)}${suffix}`;
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
        const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
        for (const [name, value] of Object.entries(this.extraHeaders)) {
            // Replace a default case-insensitively, so "user-agent" doesn't end up sent twice.
            for (const existing of Object.keys(headers)) {
                if (existing.toLowerCase() === name.toLowerCase()) {
                    delete headers[existing];
                }
            }
            headers[name] = value;
        }
        headers.Authorization = `Bearer ${this.token}`;

        let body: string | FormData | undefined;
        if (options.form !== undefined) {
            body = options.form;
        } else if (options.body !== undefined) {
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
            const data = (await response.json()) as { error?: unknown; message?: unknown; errors?: unknown; details?: unknown; detail?: unknown };
            if (data !== null && typeof data === "object" && !Array.isArray(data)) {
                details = data as Record<string, unknown>;
            }
            if (data && typeof data.error === "string" && data.error !== "") {
                code = data.error;
                message = typeof data.message === "string" && data.message !== "" ? data.message : data.error;
            }
            // Validation failures carry their reasons in a list, not in `message`.
            const reasons = typeof data?.detail === "string" ? data.detail : validationReasons(data?.errors ?? data?.details);
            if (reasons !== "" && (message === code || message === response.statusText || message === "")) {
                message = reasons;
            }
        } catch {
            // Non-JSON error body – keep the http_<status> fallback.
        }
        return new TranslatizeApiError(message, response.status, code, details);
    }
}
