# @translatize/core

Zero-dependency TypeScript SDK for the [Translatize](https://translatize.com)
integration API. It wraps the machine-token endpoints (`Authorization: Bearer
mcni_...`) and ships the flatten/unflatten helpers used to move between nested and
flat translation files.

Runtime dependencies: **none** – it uses Node's native `fetch` (Node 18+).

## Install

```bash
npm install @translatize/core
```

## Usage

```ts
import { TranslatizeClient, flatten, unflatten } from "@translatize/core";

const client = new TranslatizeClient({
    apiUrl: "https://api.translatize.com/v1",
    token: process.env.TRANSLATIZE_API_TOKEN!,
});

// Who am I / what is this token bound to?
const me = await client.me();
console.log(me.project.name, me.branch, me.role);

// Read the branch.
const { labels } = await client.listLabels({ namespace: "app", status: "approved" });

// Write one label (upsert on the token's bound branch).
await client.upsertLabel({ key: "app.title", values: { en: "Hello" } });

// Write many – chunked into server-sized batches automatically.
const result = await client.upsertLabels(bigListOfLabels);
console.log(result.updated, result.created, result.failed);

// Export a raw file body.
const json = await client.exportFile({ format: "json" });
```

The token is bound to one project and one base branch, so the client discovers
the project id itself (via `me()`, cached) – you never pass it in.

Client options: `apiUrl`, `token`, `timeoutMs` (default 30000) and `headers` – extra
headers sent on every request (they may replace `User-Agent`/`Accept`, never
`Authorization` or `Content-Type`).

### Methods

| Method | HTTP | Purpose |
| --- | --- | --- |
| `me()` | `GET /me` | Token identity: project, bound branch, branch scope, the project's source language, role, token metadata. |
| `listLabels({ namespace?, status?, branch? })` | `GET .../labels` | Read a branch's labels. |
| `exportFile({ format, lang?, sourceLang?, namespace?, branch? })` | `GET .../export` | Export a branch as a raw file body. Multi-language: `json` \| `csv` \| `yaml`. Single-language: `xliff` \| `po` \| `arb` \| `resx` \| `ios` \| `android`. |
| `upsertLabel(input, { branch? }?)` | `PATCH .../labels` | Create/update one label – `values`, `status`, `tags`, `context`. |
| `upsertLabels(inputs, { branch? }?)` | `PATCH .../labels/batch` | Create/update many (auto-chunked to 500/request). |
| `listBranches()` | `GET .../branches` | Every branch, flagged `createdByThisToken` / `writable`. |
| `createBranch({ name, description? })` | `POST .../branches` | Branch off the token's bound branch (create-own, developer+). |
| `compareBranch(name)` | `GET .../branches/:name/compare` | Diff a branch (source) against the base (target). |
| `branchConflicts(name)` | `GET .../branches/:name/conflicts` | Flat merge conflicts vs the base. |
| `mergeBranch(name, { strategy?, conflicts? }?)` | `POST .../branches/:name/merge` | Merge a token-created branch back into the base. |
| `deleteBranch(name)` | `DELETE .../branches/:name` | Delete a token-created branch. |
| `rebaseLabels(name, keys, { langs? }?)` | `POST .../branches/:name/labels/rebase` | Move keys' `branch-changes` base to their current text, without changing it (auto-chunked to 500/request). |
| `autoTranslate({ targetLangs, branch?, sourceLang?, labelKeys?, overwriteTranslated? })` | `POST .../translation/auto-translate` | Launch a background AI translation job. |
| `translationStatus()` | `GET .../translation/status` | Current/most-recent job state + AI quota (`counts.fromMemory` = values filled from translation memory). |
| `getGlossary()` | `GET .../glossary` | Project + workspace glossary terms. |
| `findTranslationMemory({ texts, sourceLang, targetLang, threshold? })` | `POST .../tm/matches` | Up to 3 TM matches per text (auto-chunked to 100 texts/request). |
| `runQa({ branch?, keys? }?)` | `POST .../qa/run` | Run the QA checks; inline result, or `{ background: true }` over 20,000 pairs. |
| `listQaIssues({ branch?, severity?, key?, lang?, source?, includeIgnored?, cursor?, limit? }?)` | `GET .../qa/issues` | One page of stored issues + counts per severity (counts never include ignored issues). |
| `getMergeGate(branch, { strategy? }?)` | `GET .../branches/:name/merge-gate` | Preview the QA merge gate for merging `branch` into the base with `strategy` (default `overwrite` – pass the one `mergeBranch` will actually use). |
| `startAiReview({ branch?, keys?, langs? }?)` | `POST .../qa/ai-review` | Queue an AI review (Professional+, own quota). |
| `aiReviewStatus()` | `GET .../qa/ai-review/status` | The latest AI review job, or `null`. |
| `createScreenshotRun({ name, branch?, commitSha? })` | `POST .../screenshots/runs` | Open a capture run (developer+, Starter plan or higher). |
| `checkScreenshots(runId, clientHashes)` | `POST .../screenshots/runs/:id/check` | Which images the server already has (auto-chunked to 500). |
| `uploadScreenshot(runId, { image?, meta, contentType?, filename? })` | `POST .../screenshots/runs/:id/screens` | Multipart upload of one screen; leave `image` out for a known `meta.clientHash`. |
| `completeScreenshotRun(runId)` | `POST .../screenshots/runs/:id/complete` | Close the run; returns the final counts. |
| `listDistributions()` | `GET .../ota/distributions` | The project's OTA distributions. |
| `publishRelease(distributionId)` | `POST .../ota/distributions/:id/releases` | Publish the distribution's branch to the CDN (developer+). |

### Branch scope

Every label method (`listLabels`, `exportFile`, `upsertLabel`, `upsertLabels`)
accepts an optional `branch` – omit it to act on the token's bound branch. A
token whose `branchScope` is `create-own` may additionally create branches off
its base, read/write/export/compare/merge/delete the branches **it** created, and
merge them back into its base:

```ts
const { branchScope } = await client.listBranches();
if (branchScope === "create-own") {
    await client.createBranch({ name: "feature-x" });
    await client.upsertLabel({ key: "app.title", values: { en: "Hi" } }, { branch: "feature-x" });
    const conflicts = await client.branchConflicts("feature-x"); // vs the base
    await client.mergeBranch("feature-x", { strategy: "overwrite" }); // target is always the base
    await client.deleteBranch("feature-x");
}
```

Naming a branch outside the token's allowed set fails with a
`TranslatizeApiError` whose `.code` is `branch_not_allowed` and whose `.details`
carries `boundBranch` and `allowedBranches`.

### Rebasing after a manual restore

If you write a branch's own copy of the base's current text for a key (for example,
undoing a key the branch had changed and then changed back), call `rebaseLabels`
right after for exactly that key/language so the `branch-changes` merge strategy
does not treat the write as a fresh branch edit – without it, a later change to the
same language on the base would be reverted by the merge:

```ts
await client.upsertLabel({ key: "auth.logout", values: { en: baseValue } }, { branch: "feature-x" });
await client.rebaseLabels("feature-x", ["auth.logout"], { langs: ["en"] });
```

### AI auto-translation

```ts
const run = await client.autoTranslate({ targetLangs: ["lv", "ru"], branch: "feature-x" });
if (run.started) {
    console.log("job", run.job.id, run.job.status);
} else {
    console.log("nothing to translate:", run.reason);
}
const { activeJob, lastJob, aiQuota } = await client.translationStatus();
console.log(activeJob?.status ?? lastJob?.status ?? "idle", `${aiQuota.remaining} chars left`);
```

### Label context

Give translators and the AI what they need: which UI element a key is, how long
it may be, and where it lives. Setting context or tags needs a developer-role
token. An item with only `context`/`tags` (no `values`) updates an existing key and
never creates one – a missing key fails with `label_not_found`.

```ts
await client.upsertLabels([
    {
        key: "checkout.payment.submit_button",
        values: { en: "Pay now" },
        context: { description: "Submit button of the payment form", charLimit: 20, location: "src/Pay.tsx:88" },
    },
]);
```

### QA and the merge gate

```ts
const run = await client.runQa({ branch: "feature-x" });
if (run.background) {
    const { counts } = await client.listQaIssues({ branch: "feature-x" }); // stored issues
} else {
    console.log(run.counts.error, "errors", run.issues.slice(0, 5));
}
const { target, gate } = await client.getMergeGate("feature-x");
if (gate.blocked) console.log(`merging into ${target} would fail with qa_gate_blocked`);
```

A merge the gate blocks throws `TranslatizeApiError` with code `qa_gate_blocked`
(the gate is in `.details.gate`); tokens cannot override it. A token merge into
`main` needs the **admin** role – otherwise `admin_token_required_for_main`.

### Screenshot capture runs

```ts
const { runId } = await client.createScreenshotRun({ name: "e2e", branch: "feature-x" });
const { existing } = await client.checkScreenshots(runId, [hash]);
await client.uploadScreenshot(runId, { image: existing.includes(hash) ? undefined : png, meta });
const { run } = await client.completeScreenshotRun(runId);
```

`uploadScreenshot` sends multipart form data with the global `FormData`/`Blob`
(Node 18.17+). The CLI's `translatize screenshots upload` does all of this for
`@translatize/playwright` captures.

### OTA releases

```ts
const { distributions } = await client.listDistributions();
const { release, manifestUrl } = await client.publishRelease(distributions[0].id);
```

Everything published is public – never put secrets in translations.

### Errors

Any non-2xx response throws a `TranslatizeApiError` with `.status` (HTTP status),
`.code` (the API's `error` field, e.g. `insufficient_permissions`, or
`http_<status>` when the body carries no code) and `.details` (the parsed error
body). Codes the 0.2.0 endpoints add: `qa_gate_blocked`,
`admin_token_required_for_main`, `feature_not_available` (with `details.feature`),
`feature_disabled`, `ai_review_quota_exceeded`, `ai_review_in_progress`,
`screenshot_quota_exceeded`, `capture_run_limit`, `run_screen_limit`,
`run_not_open`, `run_not_found`, `image_required`, `image_too_large`,
`meta_too_large`, `screenshot_pipeline_busy` (503, retry later), `nothing_to_publish`,
`nothing_to_review`, `too_many_pairs` and `label_not_found`. For validation failures
the `.message` carries the server's reasons.

### flatten / unflatten

```ts
flatten({ app: { title: "Hi" } });      // => { "app.title": "Hi" }
unflatten({ "app.title": "Hi" });        // => { app: { title: "Hi" } }
```

For valid input (all leaves are strings, no empty objects) they are exact
inverses. `flatten` drops empty objects and throws on a non-string leaf;
`unflatten` throws on a parent/child key conflict.

## License

MIT © SIA "MICRON"
