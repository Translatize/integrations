// TypeScript interfaces for the Translatize integration API (machine-token API,
// mounted at /v1/integrations). Field shapes mirror the server responses exactly.

/** A language code such as `en`, `lv`, `ru`. Treated as an opaque string. */
export type LangCode = string;

/** Project summary returned by `GET /integrations/me`. */
export interface ProjectInfo {
    id: string;
    name: string;
    langs: LangCode[];
}

/** Token metadata returned by `GET /integrations/me`. */
export interface TokenInfo {
    name: string;
    autoPublish: boolean;
    /** ISO-8601 expiry, or `null` when the token never expires. */
    expiresAt: string | null;
}

/** Response body of `GET /integrations/me`. */
export interface MeResponse {
    project: ProjectInfo;
    /** The branch this token is bound to. */
    branch: string;
    /** The token's role: `owner` | `admin` | `developer` | `translator`. */
    role: string;
    token: TokenInfo;
}

/**
 * A single label as returned by the list endpoint. `status` is an opaque string
 * (do not switch on specific values).
 */
export interface LabelRecord {
    key: string;
    values: Record<LangCode, string>;
    status: string;
    tags: string[];
    /** ISO-8601 timestamp of the last update. */
    updatedAt: string;
}

/** Response body of `GET /integrations/projects/:projectId/labels`. */
export interface ListLabelsResponse {
    branch: string;
    total: number;
    labels: LabelRecord[];
}

/** Filters for {@link TranslatizeClient.listLabels}. */
export interface ListLabelsOptions {
    /** Restrict to keys beginning with `"<namespace>."`. */
    namespace?: string;
    /** Restrict to labels carrying this status. */
    status?: string;
    /**
     * Branch to read. Must be in the token's allowed set (the bound branch, plus
     * branches this token created when its scope is `create-own`). Omit for the
     * token's bound (base) branch.
     */
    branch?: string;
}

/** Supported export formats. */
export type ExportFormat = "json" | "csv" | "ios" | "android";

/** Options for {@link TranslatizeClient.exportFile}. */
export interface ExportOptions {
    format: ExportFormat;
    /** Limit the export to a single language. */
    lang?: LangCode;
    /** Restrict to keys beginning with `"<namespace>."`. */
    namespace?: string;
    /**
     * Branch to export. Must be in the token's allowed set. Omit for the token's
     * bound (base) branch.
     */
    branch?: string;
}

/** Request-level options shared by the upsert methods. */
export interface UpsertOptions {
    /**
     * Branch to write to. Must be in the token's allowed set (the bound branch,
     * plus branches this token created when its scope is `create-own`). Omit for
     * the token's bound (base) branch.
     */
    branch?: string;
}

/** Input for creating or updating a label (upsert on the token's bound branch). */
export interface UpsertInput {
    key: string;
    /**
     * Per-language values. Every language code must be configured on the project;
     * unknown codes are rejected by the server (400 `unknown_languages`).
     */
    values?: Record<LangCode, string>;
    tags?: string[];
    /** Opaque status string. */
    status?: string;
}

/** Result of a single-label upsert. */
export interface UpsertLabelResult {
    key: string;
    branch: string;
    /** `true` when the label did not previously exist on the branch. */
    created: boolean;
    values: Record<LangCode, string>;
    status: string;
    tags: string[];
}

/** One failed item within a batch upsert. */
export interface BatchFailure {
    key?: string;
    error: string;
}

/** Aggregated result of a (possibly chunked) batch upsert. */
export interface BatchResult {
    updated: number;
    created: number;
    failed: BatchFailure[];
}

// ============================================================================
// Branches (branch scope)
// ============================================================================

/**
 * How the token may act across branches:
 * - `fixed`: only its bound branch (the default; unchanged from v1).
 * - `create-own`: its bound branch, plus branches it created (create / read /
 *   write / export / compare / merge-back / delete). It can never touch branches
 *   it did not create.
 */
export type BranchScope = "fixed" | "create-own";

/** One branch as returned by {@link TranslatizeClient.listBranches}. */
export interface BranchInfo {
    name: string;
    description: string;
    /** The branch this one was based on; `null` for `main`. */
    basedOn: string | null;
    /** ISO-8601 creation timestamp. */
    createdAt: string;
    /** `true` when THIS token created the branch. */
    createdByThisToken: boolean;
    /** `true` when the token may read/write/export this branch (it is in the allowed set). */
    writable: boolean;
}

/** Response of `GET .../branches`. Lists every branch in the project (including `main`). */
export interface ListBranchesResponse {
    /** The token's bound (base) branch. */
    baseBranch: string;
    branchScope: BranchScope;
    branches: BranchInfo[];
}

/** Input for {@link TranslatizeClient.createBranch}. The base is always the token's bound branch. */
export interface CreateBranchInput {
    /** Branch name – `^[a-zA-Z0-9_-]+$`, 1–100 chars, and not `main`. */
    name: string;
    /** Optional description (max 500 chars). */
    description?: string;
}

/** A branch record as returned by the create endpoint (mirrors the platform route). */
export interface CreatedBranch {
    name: string;
    description: string;
    isDefault: boolean;
    /** The base branch it was created from (the token's bound branch). */
    basedOn: string;
    createdBy: string;
    /** ISO-8601 timestamps. */
    createdAt: string;
    lastModified: string;
    createdByName: string;
}

/** Response of `POST .../branches`. */
export interface CreateBranchResponse {
    branch: CreatedBranch;
}

/** One per-language cell of a compare diff. `null` means the branch has no value there. */
export interface BranchDiffValue {
    sourceValue: string | null;
    targetValue: string | null;
}

/** One changed/added/deleted key in a compare result (only differing languages are listed). */
export interface BranchDiffEntry {
    key: string;
    languages: Record<LangCode, BranchDiffValue>;
}

/** The three difference buckets of a compare result. */
export interface BranchDifferences {
    changed: BranchDiffEntry[];
    added: BranchDiffEntry[];
    deleted: BranchDiffEntry[];
}

/** Counts accompanying a compare result. */
export interface CompareSummary {
    changed: number;
    added: number;
    deleted: number;
    total: number;
}

/**
 * Response of `GET .../branches/:name/compare`. Compares the named branch (source)
 * against the token's base branch (target).
 */
export interface CompareResponse {
    source: string;
    target: string;
    differences: BranchDifferences;
    summary: CompareSummary;
}

/** One flat merge conflict – a single key+language whose value differs on both sides. */
export interface BranchConflict {
    key: string;
    lang: LangCode;
    sourceValue: string;
    targetValue: string;
}

/**
 * Response of `GET .../branches/:name/conflicts`. Flat conflicts of the named
 * branch (source) against the token's base branch (target).
 */
export interface ConflictsResponse {
    source: string;
    target: string;
    conflicts: BranchConflict[];
    hasConflicts: boolean;
    conflictCount: number;
}

/**
 * Merge strategies. `overwrite` (default) is a non-destructive union where source
 * wins conflicts; `replace` is destructive (target becomes a copy of source);
 * `keep-newer` keeps whichever label changed more recently; `manual` uses the
 * per-conflict resolutions supplied in {@link MergeOptions.conflicts}.
 */
export type MergeStrategy = "overwrite" | "replace" | "keep-newer" | "manual";

/** One manual conflict resolution (only consulted with the `manual` strategy). */
export interface MergeConflictResolution {
    key: string;
    lang: LangCode;
    resolution: "source" | "target" | "custom";
    /** Required when `resolution` is `"custom"`. */
    customValue?: string;
}

/**
 * Options for {@link TranslatizeClient.mergeBranch}. The merge target is always the
 * token's base branch – it cannot be named here.
 */
export interface MergeOptions {
    /** Defaults to `overwrite`. */
    strategy?: MergeStrategy;
    /** Only consulted for the `manual` strategy. */
    conflicts?: MergeConflictResolution[];
}

/** Response of `POST .../branches/:name/merge`. The source branch is NOT deleted by a merge. */
export interface MergeResult {
    message: string;
    source: string;
    target: string;
    strategy: string;
}

/** Response of `DELETE .../branches/:name`. */
export interface DeleteBranchResult {
    message: string;
}

// ============================================================================
// AI auto-translation
// ============================================================================

/** Options for {@link TranslatizeClient.autoTranslate}. */
export interface AutoTranslateOptions {
    /** Branch to translate. Must be in the token's allowed set. Omit for the base branch. */
    branch?: string;
    /** Languages to translate INTO. Must be a subset of the project's languages. Required. */
    targetLangs: LangCode[];
    /** Language to translate FROM. Defaults to the project's first language. */
    sourceLang?: LangCode;
    /** Restrict to these label keys; omit to translate every label needing work. */
    labelKeys?: string[];
    /** Re-translate targets that already have a value. Defaults to `false`. */
    overwriteTranslated?: boolean;
}

/** Per-outcome value counts for a translation job. */
export interface TranslationJobCounts {
    /** Distinct labels with at least one target language needing translation. */
    requestedLabels: number;
    /** Successfully written label × language values. */
    translatedValues: number;
    /** Values that could not be translated after retries. */
    failedValues: number;
    /** Values skipped because the source text was empty (not an error). */
    skippedValues: number;
}

/** Billed-character counters for a translation job. */
export interface TranslationJobChars {
    /** Full billed-character estimate computed at launch. */
    estimated: number;
    /** Actual billed characters metered so far. */
    actual: number;
}

/** The job acknowledgement returned when a translation run starts (HTTP 202). */
export interface TranslationJob {
    id: string;
    /** `queued` | `running` | `completed` | `failed`. */
    status: string;
    targetLangs: LangCode[];
    counts: TranslationJobCounts;
    chars: TranslationJobChars;
}

/** Auto-translate accepted the request and started a background job (HTTP 202). */
export interface AutoTranslateStarted {
    started: true;
    branch: string;
    job: TranslationJob;
}

/** Auto-translate found nothing eligible to translate (HTTP 200). */
export interface AutoTranslateNothingToDo {
    started: false;
    nothingToTranslate: true;
    /** Why nothing ran – e.g. `no_source` or `already_translated`. */
    reason: string;
    sourceLang: LangCode;
    branch: string;
}

/** Result of {@link TranslatizeClient.autoTranslate}: either a started job or a no-op. */
export type AutoTranslateResult = AutoTranslateStarted | AutoTranslateNothingToDo;

/** AI-translation quota from the project's billing-owner subscription. `limit` of `-1` means unlimited. */
export interface AiQuota {
    used: number;
    limit: number;
    remaining: number;
}

/**
 * The live (active) translation job – the value of
 * {@link TranslationStatusResponse.activeJob}. Fields beyond `status` and
 * `targetLangs` appear by phase: `position` (1-based place in the global FIFO)
 * while `queued`; `requestedLabels` and `startedAt` while `running`.
 */
export interface TranslationJobState {
    jobId: string;
    /** `queued` | `running` | `completed` | `failed`. */
    status: string;
    targetLangs: LangCode[];
    /** FIFO position across all projects, present while `queued`. */
    position?: number;
    requestedLabels?: number;
    counts?: TranslationJobCounts;
    chars?: TranslationJobChars;
    /** ISO-8601 timestamps. */
    startedAt?: string | null;
    finishedAt?: string | null;
    /** Machine-readable outcome note; `null` on a clean success. */
    error?: string | null;
}

/**
 * The most-recent translation job for the project (newest by creation time,
 * whatever its state). Its shape differs from {@link TranslationJobState}: the id
 * field is `id` (not `jobId`), it additionally carries `branch` and `sourceLang`,
 * and it always includes the full `counts`/`chars`.
 */
export interface LastJobState {
    id: string;
    /** `queued` | `running` | `completed` | `failed`. */
    status: string;
    branch: string;
    sourceLang: LangCode;
    targetLangs: LangCode[];
    counts: TranslationJobCounts;
    chars: TranslationJobChars;
    /** Machine-readable outcome note; `null` on a clean success. */
    error: string | null;
    /** ISO-8601 timestamps, or `null` when the job never reached that phase. */
    startedAt: string | null;
    finishedAt: string | null;
}

/** Response of `GET .../translation/status`. */
export interface TranslationStatusResponse {
    /** The live job (queued or running), or `null` when none is active. */
    activeJob: TranslationJobState | null;
    /** The most-recent job of any state, or `null` when the project has never run one. */
    lastJob: LastJobState | null;
    aiQuota: AiQuota;
}
