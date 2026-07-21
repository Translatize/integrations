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

### Methods

| Method | HTTP | Purpose |
| --- | --- | --- |
| `me()` | `GET /me` | Token identity: project, bound branch, role, token metadata. |
| `listLabels({ namespace?, status?, branch? })` | `GET .../labels` | Read a branch's labels. |
| `exportFile({ format, lang?, namespace?, branch? })` | `GET .../export` | Export a branch as a raw file body (`json` \| `csv` \| `ios` \| `android`). |
| `upsertLabel(input, { branch? }?)` | `PATCH .../labels` | Create/update one label. |
| `upsertLabels(inputs, { branch? }?)` | `PATCH .../labels/batch` | Create/update many (auto-chunked to 500/request). |
| `listBranches()` | `GET .../branches` | Every branch, flagged `createdByThisToken` / `writable`. |
| `createBranch({ name, description? })` | `POST .../branches` | Branch off the token's bound branch (create-own, developer+). |
| `compareBranch(name)` | `GET .../branches/:name/compare` | Diff a branch (source) against the base (target). |
| `branchConflicts(name)` | `GET .../branches/:name/conflicts` | Flat merge conflicts vs the base. |
| `mergeBranch(name, { strategy?, conflicts? }?)` | `POST .../branches/:name/merge` | Merge a token-created branch back into the base. |
| `deleteBranch(name)` | `DELETE .../branches/:name` | Delete a token-created branch. |
| `autoTranslate({ targetLangs, branch?, sourceLang?, labelKeys?, overwriteTranslated? })` | `POST .../translation/auto-translate` | Launch a background AI translation job. |
| `translationStatus()` | `GET .../translation/status` | Current/most-recent job state + AI quota. |

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

### Errors

Any non-2xx response throws a `TranslatizeApiError` with `.status` (HTTP status)
and `.code` (the API's `error` field, e.g. `insufficient_permissions`, or
`http_<status>` when the body carries no code).

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
