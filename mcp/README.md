# @translatize/mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents – Claude
Code, Cursor, Claude Desktop, and any other Model Context Protocol client –
direct access to your [Translatize](https://translatize.com) translations, with
git-like branching.

It runs over stdio and exposes eighteen tools for reading and writing labels
(translation keys), translating, and managing branches: inspect the project,
list/search/read/upsert keys, check per-language coverage, find and fill missing
translations (yourself or with platform AI), and – with a `create-own` scoped
token – create, compare, review, merge and delete branches. Built on
[`@translatize/core`](https://www.npmjs.com/package/@translatize/core) and the
machine-token integration API.

Requires Node.js >= 18.17.

## How it works

The server authenticates with a **Translatize API token** (a string beginning
with `mcni_`). Every token is bound to one project and one **base branch**, and
carries a **branch scope**:

- **`fixed`** (the default) – the token can only read and write its one base
  branch. This is exactly the original behaviour.
- **`create-own`** – in addition to its base branch, the token may create new
  branches (always forked from the base), read/write/export the branches it
  created, and compare, merge and delete those back into the base. It can never
  touch branches it did not create.

Call `get_project_info` (or `list_branches`) to see the base branch, the scope,
and which branches the token may write to. The label and translation tools take
an optional `branch` argument naming any branch in that allowed set; omit it to
act on the base branch.

Create a token – and choose its branch scope – under **Project Settings →
Integrations** at [app.translatize.com](https://app.translatize.com).

## Configuration

The server is configured entirely through environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `TRANSLATIZE_API_TOKEN` | **yes** | The `mcni_...` integration token. The server exits immediately if it is missing. |
| `TRANSLATIZE_API_URL` | no | API base URL including the `/v1` segment. Defaults to `https://api.translatize.com/v1`. |
| `TRANSLATIZE_APP_URL` | no | Web-app base URL used to build the `platformUrl` review link returned by `review_changes`. Defaults to `https://app.translatize.com`. |

## Setup

### Claude Code

```bash
claude mcp add translatize -e TRANSLATIZE_API_TOKEN=mcni_xxx -- npx -y @translatize/mcp
```

This registers the server so Claude Code launches it on demand with `npx`. Drop
`-e TRANSLATIZE_API_TOKEN=...` if the variable is already exported in your shell.

### Cursor

Add the server to `.cursor/mcp.json` in your project (or the global
`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "translatize": {
      "command": "npx",
      "args": ["-y", "@translatize/mcp"],
      "env": {
        "TRANSLATIZE_API_TOKEN": "mcni_xxx"
      }
    }
  }
}
```

### Any MCP client (Claude Desktop, etc.)

The same `mcpServers` block works for any client that speaks MCP over stdio –
for Claude Desktop, put it in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "translatize": {
      "command": "npx",
      "args": ["-y", "@translatize/mcp"],
      "env": {
        "TRANSLATIZE_API_TOKEN": "mcni_xxx",
        "TRANSLATIZE_API_URL": "https://api.translatize.com/v1"
      }
    }
  }
}
```

The binary is `translatize-mcp`; `npx -y @translatize/mcp` runs it without a
global install. If you prefer a pinned install, `npm i -g @translatize/mcp` and
set `"command": "translatize-mcp"` with `"args": []`.

## Tools

Every label and translation tool accepts an optional `branch` argument. It
defaults to the token's base branch and may name any branch in the token's
allowed set (a `create-own` token's base plus the branches it created); naming a
branch outside that set fails with `branch_not_allowed`.

### Project & labels

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_project_info` | _none_ | Project name and id, configured languages, base branch, token role, **branch scope**, the **writable branches**, total key count, and per-language completeness %. Call this first. |
| `list_labels` | `namespace?`, `status?`, `include_values?`, `branch?` | Keys with their status and tags (plus values when `include_values` is true). Filter by namespace (dotted key prefix) and/or status. Values are capped at 300 with a note. |
| `get_labels` | `keys[]`, `branch?` | The full record (all values, status, tags) for each named key, plus a `not_found` list. |
| `search_labels` | `query`, `in?` (`keys`/`values`/`both`), `branch?` | Labels whose key or value contains `query` (case-insensitive), with values, capped at 100 matches. |
| `upsert_label` | `key`, `values?`, `status?`, `tags?`, `branch?` | Creates or updates one label; reports whether it was created or updated and its stored state. |
| `upsert_labels` | `labels[]`, `branch?` | Batch create/update (chunked automatically); returns `{ updated, created, failed }`. |
| `set_labels_status` | `keys[]`, `status`, `branch?` | Bulk-set the workflow status (`draft`/`review`/`approved`/`rejected`) of many keys without touching their values. |

### Translation

| Tool | Arguments | Returns |
| --- | --- | --- |
| `translation_status` | `branch?` | Per language: total keys, translated, missing, and up to 50 example missing keys. |
| `get_missing_translations` | `branch?`, `languages?`, `limit?` (default 200) | Keys with at least one empty target-language value: `{ key, source: { lang, value }, missing: [langs] }`. Translate these **yourself** (any plan) and write them back with `upsert_labels`. |
| `auto_translate` | `branch?`, `target_languages?`, `label_keys?`, `overwrite_translated?` | Starts a **platform AI** background job (professional/agency plans; metered against the AI quota). Returns the started job, or a no-op when nothing needs work. `feature_not_available` ⇒ use `get_missing_translations` and translate yourself. |
| `translation_job_status` | _none_ | The current/most-recent AI job (status, progress, queue position) plus the AI quota `{ used, limit, remaining }`. |

### Branches (`create-own` tokens)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_branches` | _none_ | Every branch with `writable` and `createdByThisToken` flags, plus `baseBranch` and `branchScope`. |
| `create_branch` | `name`, `description?` | Forks a new branch from the base branch. Needs a `create-own` token and the developer role. Name: `^[a-zA-Z0-9_-]+$`, 1–100 chars, not `main`. |
| `compare_with_base` | `branch` | Changed/added/deleted keys of `branch` vs the base, each with per-language values, plus a summary. |
| `get_merge_conflicts` | `branch` | Flat per-key/per-language conflicts of `branch` vs the base; an empty list means it is safe to merge with the default strategy. |
| `review_changes` | `branch?` | A capped (100-key) review packet – added/changed keys with values – plus a `platformUrl` to open in the web app. Call it, then **ask the user** how to review and whether to merge. |
| `merge_branch` | `branch`, `strategy?`, `conflicts?` | Merges a branch you created into the base. Strategies: `overwrite` (default), `keep-newer`, `manual` (pass resolutions from `get_merge_conflicts`), `replace` (destructive). Does **not** delete the branch. |
| `delete_branch` | `branch` | Deletes a branch this token created (cleanup after a merge). |

Only languages configured on the project may be written; an unknown language
code is rejected. When a call fails, the tool returns an error result whose text
carries the API error code and a short remedy (for example, `branch_not_allowed`
lists the branches the token may act on, and `feature_not_available` points at
`get_missing_translations`), so the agent can react without the session crashing.

## Agentic workflow

With a `create-own` token, an agent can take a translation change from start to
finish inside the conversation:

1. **Branch.** `create_branch { name: "add-checkout-copy" }` forks a working
   branch from the base.
2. **Add keys.** `upsert_labels { branch: "add-checkout-copy", labels: [...] }`
   writes the new source strings.
3. **Translate.** Either translate yourself –
   `get_missing_translations { branch: "add-checkout-copy" }`, fill in the
   values, and push them with `upsert_labels` – or, on a plan with platform AI,
   `auto_translate { branch: "add-checkout-copy" }` and watch it with
   `translation_job_status`.
4. **Mark reviewed.**
   `set_labels_status { branch: "add-checkout-copy", keys: [...], status: "approved" }`.
5. **Review + ask.** `review_changes { branch: "add-checkout-copy" }` returns the
   diff and a `platformUrl`. Ask the user whether to review here or on the
   platform, and get their approval – never merge on your own.
6. **Merge.** After approval, `merge_branch { branch: "add-checkout-copy" }` folds
   it into the base (use `get_merge_conflicts` + strategy `manual` if there are
   conflicts).
7. **Clean up.** `delete_branch { branch: "add-checkout-copy" }`.

A `fixed`-scope token skips the branching steps and works directly on its one
branch (steps 2–4).

## Example prompts

Once connected, ask the agent things like:

- "What languages does this Translatize project support, and how complete is each
  one?"
- "List every key under the `checkout` namespace that is still in draft status."
- "Add a key `checkout.pay_button` with English `Pay now` and Latvian `Maksāt`."
- "Which Latvian strings are still missing? Draft translations for the first ten."
- "Create a branch, add the new onboarding keys, translate the missing Latvian
  strings, and show me the changes before merging."

## Privacy Policy

This server is a thin, local bridge between your MCP client and the Translatize
API. It:

- reads your **Translatize API token** from the `TRANSLATIZE_API_TOKEN`
  environment variable and sends it, over HTTPS as a Bearer token, **only** to the
  Translatize API host you configure (`TRANSLATIZE_API_URL`, default
  `https://api.translatize.com/v1`);
- sends and receives **translation data** (label keys, values, statuses, tags and
  branch metadata) to and from that API in response to tool calls;
- runs entirely locally over stdio, adds **no telemetry or analytics**, and
  contacts no other host. Diagnostics are written to stderr only; your token is
  never written to stdout or logged.

The data you read and write through these tools is handled under the Translatize
privacy policy: **https://translatize.com/en/privacy**.

## License

MIT © SIA "MICRON"
