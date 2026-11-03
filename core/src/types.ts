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
    /** How far the token reaches beyond its bound branch (see {@link BranchScope}). */
    branchScope?: BranchScope;
    /**
     * The project's source language (its setting, else `en` when configured, else the
     * first language). Servers before 0.2.0 leave it out – fall back to `project.langs[0]`.
     */
    sourceLanguage?: LangCode;
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

/**
 * Supported export formats.
 *
 * `json`, `csv` and `yaml` hold every project language in one file; the rest are
 * single-language and export `lang` (or the project's first language when `lang` is
 * omitted). `xliff` is bilingual — it pairs each translation with its source text, see
 * {@link ExportOptions.sourceLang}.
 */
export type ExportFormat =
    | "json" | "csv" | "yaml" | "xliff" | "po" | "arb" | "resx" | "ios" | "android";

/** Options for {@link TranslatizeClient.exportFile}. */
export interface ExportOptions {
    format: ExportFormat;
    /** Limit the export to a single language. */
    lang?: LangCode;
    /**
     * Language to translate *from*, for the bilingual formats (`xliff`, and the
     * translator comments in `po`). Ignored by every other format. Defaults to English
     * when the project has it, otherwise another project language.
     */
    sourceLang?: LangCode;
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

/**
 * Translator context for a label: what the string is, how long it may be and where
 * it lives. AI translation and the QA `length` check read it. Setting it needs a
 * developer-role token or higher.
 */
export interface LabelContext {
    /** Which UI element this is and where it appears (max 1,000 chars). */
    description?: string;
    /** Maximum length of every translation, 1–10,000. `null` removes the limit. */
    charLimit?: number | null;
    /** Where the string is used, e.g. `src/Checkout.tsx:42` (max 300 chars). */
    location?: string;
    /**
     * "Do not translate": the text stays the same in every language (product names,
     * brands, codes). AI translation copies the source text instead of translating it
     * and QA accepts the copy. `false` clears it.
     */
    doNotTranslate?: boolean;
}

/** Input for creating or updating a label (upsert on the token's bound branch). */
export interface UpsertInput {
    key: string;
    /**
     * Per-language values. Every language code must be configured on the project;
     * unknown codes are rejected by the server (400 `unknown_languages`).
     */
    values?: Record<LangCode, string>;
    /** Max 20 tags, each max 50 chars. Setting tags needs the developer role or higher. */
    tags?: string[];
    /** Opaque status string. */
    status?: string;
    /**
     * Translator context. Only the fields given change; the server refuses an empty
     * object. An item that carries only `context` and/or `tags` (no `values`)
     * updates an existing label and never creates one – a missing key fails with
     * `label_not_found`.
     */
    context?: LabelContext;
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
    /** The label's context after the write – present only when the request set `context`. */
    context?: LabelContext;
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
 * per-conflict resolutions supplied in {@link MergeOptions.conflicts};
 * `branch-changes` applies only what the source branch itself created or changed
 * since it was created – per language, compared with what it was copied as (source
 * wins for those) – leaves everything else on the target untouched and does not
 * propagate deletions; the result lists the keys the target also changed meanwhile
 * in {@link MergeResult.overlappingKeys}.
 */
export type MergeStrategy = "overwrite" | "replace" | "keep-newer" | "manual" | "branch-changes";

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

/** The QA merge gate as it stood when a merge went through (no issue list). */
export interface MergeGateChecked {
    mode: MergeGateMode;
    applies: boolean;
    blocked: boolean;
    errors: number;
    warnings: number;
    pairsChecked: number;
    /** Always `false` for token merges – tokens cannot override the gate. */
    overridden: boolean;
    error?: undefined;
}

/**
 * The gate could not be evaluated, and the merge went ahead unchecked: it could not
 * have blocked (mode `warn` or `off`, or a target it does not apply to). Where it
 * could block, the merge is refused with 503 `qa_gate_unavailable` instead.
 */
export interface MergeGateUnavailable {
    mode: MergeGateMode;
    applies: boolean;
    error: "gate_unavailable";
}

/** Check `"error" in gate` (or `gate.error`) before reading the counts. */
export type MergeGateSummary = MergeGateChecked | MergeGateUnavailable;

/** Response of `POST .../branches/:name/merge`. The source branch is NOT deleted by a merge. */
export interface MergeResult {
    message: string;
    source: string;
    target: string;
    strategy: string;
    /** The QA gate result for this merge (servers before 0.2.0 leave it out). */
    gate?: MergeGateSummary | null;
    /**
     * `branch-changes` only: merged keys where the target had also changed a written
     * language since the source branch was created, to another text (the source's
     * value won). At most 200, sorted.
     */
    overlappingKeys?: string[];
    /** `branch-changes` only: how many such keys there are in all (the list stops at 200). */
    overlappingCount?: number;
}

/** Response of `DELETE .../branches/:name`. */
export interface DeleteBranchResult {
    message: string;
}

/** Options for {@link TranslatizeClient.rebaseLabels}. */
export interface RebaseLabelsOptions {
    /** Only move these languages' base; omit to move every language the label currently holds. */
    langs?: LangCode[];
}

/**
 * Response of `POST .../branches/:name/labels/rebase`.
 */
export interface RebaseLabelsResult {
    /** How many of `keys` were found on the branch and had their base moved. */
    rebased: number;
    /** Keys from the request that are not on the branch. */
    notFound: string[];
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
    /** Language to translate FROM. Defaults to the project's source language (settings, else `en`, else the first language). */
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
    /** Values filled from an exact translation-memory match instead of the AI (not billed). */
    fromMemory?: number;
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

// ============================================================================
// Glossary and translation memory
// ============================================================================

/** One glossary term, from the project or its workspace. */
export interface GlossaryTerm {
    id: string;
    term: string;
    /** The required translation per language. A translation equal to the term means "do not translate". */
    translations: Record<LangCode, string>;
    description: string | null;
    caseSensitive: boolean;
    /** A prohibited term must never appear in a translation. */
    prohibited: boolean;
    category: string | null;
    scope: "project" | "workspace";
}

/** Response of `GET .../glossary`. */
export interface GlossaryResponse {
    terms: GlossaryTerm[];
}

/** Input for {@link TranslatizeClient.findTranslationMemory}. */
export interface TmMatchesInput {
    /** Source texts to look up. Sent in chunks of 100. */
    texts: string[];
    sourceLang: LangCode;
    targetLang: LangCode;
    /** Minimum match score, 50–100. The server defaults to 75. */
    threshold?: number;
}

/** One translation-memory match for a source text. */
export interface TmMatch {
    sourceText: string;
    /** The stored translation, with placeholders already renamed to the query's names. */
    targetText: string;
    /** Similarity, 0–100 (100 = exact). */
    match: number;
    /** Entry quality, 0–1 (1 = approved, 0.8 = human edit). */
    quality: number;
    /** `true` when placeholder names were mapped from the stored entry to the query. */
    placeholderMapped: boolean;
    /** `manual` | `approved` | `human_edit`. */
    origin: string;
}

/** The matches for one queried text (at most 3, best first). */
export interface TmMatchResult {
    text: string;
    matches: TmMatch[];
}

/** Response of `POST .../tm/matches` (merged across chunks by the client). */
export interface TmMatchesResponse {
    results: TmMatchResult[];
}

// ============================================================================
// QA checks and the merge gate
// ============================================================================

export type QaSeverity = "error" | "warning" | "info";

/** One QA finding on a key × language pair. */
export interface QaIssue {
    id: string;
    branch: string;
    key: string;
    lang: LangCode;
    /** The check that raised it, e.g. `placeholders`, `length`, `glossary`. */
    checkId: string;
    severity: QaSeverity;
    /** Machine-readable issue code; the web app renders the message from `code` + `params`. */
    code: string;
    params: Record<string, unknown>;
    /** `rule` for the built-in checks, `ai` for AI review findings. */
    source: "rule" | "ai";
    /** Free-text message (AI review findings). */
    message?: string;
    /** Suggested fix (AI review findings). */
    suggestion?: string;
    ignored: boolean;
    /** Why it was ignored – only on ignored issues. */
    ignoredReason?: string;
    /** ISO-8601 timestamp of the ignore – only on ignored issues. */
    ignoredAt?: string;
    /** ISO-8601 timestamp. */
    createdAt: string;
}

/** Open issue counts per severity – ignored issues and AI score rows are not counted. */
export interface QaCounts {
    error: number;
    warning: number;
    info: number;
}

/** Options for {@link TranslatizeClient.runQa}. */
export interface RunQaOptions {
    /** Branch to check. Must be in the token's allowed set. Omit for the base branch. */
    branch?: string;
    /** Only re-check these keys. */
    keys?: string[];
}

/** QA ran synchronously (up to 20,000 key × language pairs). */
export interface QaRunCompleted {
    background?: false;
    branch: string;
    pairsChecked: number;
    counts: QaCounts;
    /** The first 200 issues. */
    issues: QaIssue[];
}

/** QA was too big to run inline and continues in the background (HTTP 202). */
export interface QaRunBackground {
    background: true;
    branch: string;
}

/** Result of {@link TranslatizeClient.runQa}. Check `background` first. */
export type QaRunResult = QaRunCompleted | QaRunBackground;

/** Filters for {@link TranslatizeClient.listQaIssues}. */
export interface ListQaIssuesOptions {
    branch?: string;
    severity?: QaSeverity;
    key?: string;
    /** Only issues in this target language. */
    lang?: LangCode;
    source?: "rule" | "ai";
    /** Also list ignored issues (the counts never include them). */
    includeIgnored?: boolean;
    /** The `nextCursor` of the previous page. */
    cursor?: string;
    /** Page size, max 500, default 100. */
    limit?: number;
}

/** Response of `GET .../qa/issues`. */
export interface QaIssuesResponse {
    issues: QaIssue[];
    /** Pass as `cursor` for the next page; `null` on the last page. */
    nextCursor: string | null;
    counts: QaCounts;
}

export type MergeGateMode = "off" | "warn" | "block";

/** The QA merge gate for one merge, re-evaluated on the pairs the merge would change. */
export interface MergeGate {
    mode: MergeGateMode;
    /** `false` when the gate is off or does not cover this target branch. */
    applies: boolean;
    /** `true` when the merge would be refused with `qa_gate_blocked`. */
    blocked: boolean;
    errors: number;
    warnings: number;
    pairsChecked: number;
    /** The first 200 issues. */
    issues: QaIssue[];
}

/** Options for {@link TranslatizeClient.getMergeGate}. */
export interface MergeGateOptions {
    /**
     * The strategy whose writes are previewed (default `overwrite`). Pass the one the
     * merge will use: `branch-changes` checks far fewer pairs than `overwrite`.
     */
    strategy?: MergeStrategy;
}

/** Response of `GET .../branches/:name/merge-gate`. The target is the token's base branch. */
export interface MergeGateResponse {
    /** The branch the preview is for. */
    source?: string;
    target: string;
    gate: MergeGate;
}

// ============================================================================
// AI review
// ============================================================================

/** Options for {@link TranslatizeClient.startAiReview}. */
export interface StartAiReviewOptions {
    branch?: string;
    /** Only review these keys. */
    keys?: string[];
    /** Only review these target languages. */
    langs?: LangCode[];
}

/** The queued AI review job (HTTP 202). */
export interface AiReviewStarted {
    jobId: string;
    status: "queued";
    /** Key × language pairs to review. */
    pairs: number;
    /** Characters of target text the review will bill at most. */
    estimatedCharacters: number;
}

export type AiReviewJobStatus = "queued" | "running" | "completed" | "failed";

/** The project's latest AI review job. */
export interface AiReviewJob {
    id: string;
    status: AiReviewJobStatus;
    branch: string;
    /** `manual`, or `auto` for a review queued after a translation job. */
    trigger?: string;
    /** Target languages reviewed; empty = every target language. */
    langs?: LangCode[];
    counts: { total: number; reviewed: number; failed: number; issues: number };
    estimatedCharacters?: number;
    charactersBilled: number;
    /** Machine-readable outcome note; `null` on a clean success. */
    error: string | null;
    /** ISO-8601 timestamps. */
    createdAt: string;
    startedAt?: string | null;
    finishedAt: string | null;
}

/** The AI review quota of the project's billing owner. `limit` of `-1` means unlimited. */
export interface AiReviewQuota {
    /** `false` when the plan has no AI review. */
    enabled: boolean;
    used: number;
    limit: number;
    /** `-1` when the limit is unlimited. */
    remaining: number;
    /** UTC month the usage counts for, `YYYY-MM`. */
    month: string;
}

/** Response of `GET .../qa/ai-review/status`. */
export interface AiReviewStatusResponse {
    job: AiReviewJob | null;
    quota?: AiReviewQuota;
    /** The project's source language, the side the review compares against. */
    sourceLanguage?: LangCode;
}

// ============================================================================
// Screenshot capture runs
// ============================================================================

/** Input for {@link TranslatizeClient.createScreenshotRun}. */
export interface CreateScreenshotRunInput {
    /** Branch whose labels the text matcher uses. Omit for the base branch. */
    branch?: string;
    /** A name for the run, e.g. the CI job. */
    name: string;
    commitSha?: string;
}

/** Response of `POST .../screenshots/runs` (HTTP 201). */
export interface ScreenshotRunCreated {
    runId: string;
}

/** A rectangle in CSS pixels of the captured image. */
export interface ScreenshotRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** One piece of text (or a marker / attribute) found on the captured page. */
export interface ScreenshotRegion {
    text?: string;
    /** The label key, when known exactly. */
    key?: string;
    /** Marker hash decoded by `@translatize/playwright` (first 10 hex chars of sha256 of the key). */
    marker?: string;
    attr?: "placeholder" | "title" | "aria-label" | "alt";
    rect: ScreenshotRect;
}

/** The `meta` part of a screen upload – a capture JSON without `capturedAt` / `fullPage`. */
export interface ScreenshotMeta {
    name: string;
    viewport?: { width: number; height: number };
    locale?: string;
    /** sha256 hex of the PNG bytes. Lets the server reuse an image it already has. */
    clientHash?: string;
    regions: ScreenshotRegion[];
}

/** Input for {@link TranslatizeClient.uploadScreenshot}. */
export interface UploadScreenshotInput {
    /** Image bytes (PNG, JPEG or WebP, max 10 MB). Omit when `meta.clientHash` is already known to the server. */
    image?: Uint8Array;
    meta: ScreenshotMeta;
    /** Defaults to `image/png`. */
    contentType?: string;
    /** File name sent with the image part. Defaults to `screen.png`. */
    filename?: string;
}

/** Response of `POST .../screenshots/runs/:runId/screens` (HTTP 201). */
export interface ScreenshotUploadResult {
    screenshotId: string;
    /** `true` when an identical image was already stored for the project. */
    deduped: boolean;
    /** Number of key links created for this screen. */
    links: number;
}

/** Response of `POST .../screenshots/runs/:runId/check`. */
export interface ScreenshotCheckResult {
    /** The client hashes the server already holds an image for. */
    existing: string[];
}

/** Response of `POST .../screenshots/runs/:runId/complete`. */
export interface CompleteScreenshotRunResult {
    run: {
        id: string;
        name?: string;
        branch?: string;
        commitSha?: string | null;
        /** `open` | `completed` | `failed`. */
        status: string;
        counts: { screens: number; linked: number; ambiguous: number; superseded: number };
        /** ISO-8601 timestamps. */
        createdAt?: string;
        completedAt?: string | null;
    };
}

// ============================================================================
// OTA delivery
// ============================================================================

/** One over-the-air delivery distribution. */
export interface OtaDistribution {
    id: string;
    name: string;
    /** The public id in CDN paths (`/d/<publicId>/manifest.json`); the SDK's `distributionId`. */
    publicId: string;
    /** The branch a release publishes. */
    branch: string;
    /** `all` non-empty values, or `approved` labels only. */
    publishFilter: "all" | "approved";
    format: "json-flat" | "json-nested";
    autoPublishOnMerge: boolean;
    status: "active" | "disabled";
    /** Latest published version, or `null` before the first release. */
    latestVersion: number | null;
    manifestUrl: string;
}

/** Response of `GET .../ota/distributions`. */
export interface ListDistributionsResponse {
    distributions: OtaDistribution[];
}

/** One published OTA release. */
export interface OtaRelease {
    version: number;
    labelCount: number;
    languages: Record<LangCode, { path: string; hash: string; bytes: number }>;
    /** ISO-8601 timestamp. */
    createdAt: string;
}

/** Response of `POST .../ota/distributions/:id/releases` (HTTP 201). */
export interface PublishReleaseResult {
    release: OtaRelease;
    manifestUrl: string;
}
