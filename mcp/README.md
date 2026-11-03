# @translatize/mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents – Claude
Code, Cursor, Claude Desktop, and any other Model Context Protocol client –
direct access to your [Translatize](https://translatize.com) translations, with
git-like branching.

It runs over stdio and exposes twenty-eight tools and two workflow prompts for
reading and writing labels (translation keys), translating, checking quality and
managing branches: inspect the project, list/search/read/upsert keys with their
translator context, check per-language coverage, read the glossary and
translation memory, find and fill missing translations (yourself or with platform
AI), run QA checks and preview the merge gate, start an AI review, publish
over-the-air releases, and – with a `create-own` scoped token – create, compare,
review, merge and delete branches. Built on
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
| `upsert_label` | `key`, `values?`, `status?`, `tags?`, `context?`, `branch?` | Creates or updates one label; reports whether it was created or updated and its stored state. `context` = `{ description?, charLimit?, location?, doNotTranslate? }`. |
| `upsert_labels` | `labels[]`, `branch?` | Batch create/update (chunked automatically); each item may carry `context`. Returns `{ updated, created, failed }`. |
| `set_label_context` | `labels[]` (`{ key, description?, charLimit?, location?, doNotTranslate?, tags? }`), `branch?` | Sets translator context on existing keys without touching their values (developer role). A missing key fails with `label_not_found`. |
| `set_labels_status` | `keys[]`, `status`, `branch?` | Bulk-set the workflow status (`draft`/`review`/`approved`/`rejected`) of many keys without touching their values. |
| `get_glossary` | _none_ | Project and workspace glossary terms: required translations, case sensitivity, prohibited terms. |
| `find_translation_memory` | `texts[]`, `target_lang`, `source_lang?`, `threshold?` | Up to 3 translation-memory matches per text with score and quality, placeholders mapped to your text. |

### Translation

| Tool | Arguments | Returns |
| --- | --- | --- |
| `translation_status` | `branch?` | Per language: total keys, translated, missing, and up to 50 example missing keys. |
| `get_missing_translations` | `branch?`, `languages?`, `limit?` (default 200) | Keys with at least one empty target-language value: `{ key, source: { lang, value }, missing: [langs] }`. Translate these **yourself** (any plan) and write them back with `upsert_labels`. |
| `auto_translate` | `branch?`, `target_languages?`, `label_keys?`, `overwrite_translated?` | Starts a **platform AI** background job (professional/agency plans; metered against the AI quota). Returns the started job, or a no-op when nothing needs work. `feature_not_available` ⇒ use `get_missing_translations` and translate yourself. |
| `translation_job_status` | _none_ | The current/most-recent AI job (status, progress, queue position) plus the AI quota `{ used, limit, remaining }`. |

### Quality

| Tool | Arguments | Returns |
| --- | --- | --- |
| `run_qa` | `branch?`, `keys?` | Runs the QA checks now (placeholders, ICU, HTML tags, length, whitespace, untranslated, glossary, numbers, punctuation): counts per severity and the issues, plus what to do next. Changes no translation. |
| `get_qa_issues` | `branch?`, `severity?`, `key?`, `lang?`, `source?`, `cursor?`, `limit?` | One page of stored issues with counts; `source: "ai"` lists AI review findings. |
| `check_merge_gate` | `branch`, `strategy?` | The merge gate for merging `branch` into the base with `strategy` (default `overwrite` – pass the one you will give `merge_branch`; the pairs checked differ per strategy): mode, applies, **blocked**, errors and warnings, plus a verdict. A blocked gate makes `merge_branch` fail with `qa_gate_blocked`. |
| `start_ai_review` | `branch?`, `keys?`, `langs?` | Queues a platform AI review (Professional plan or higher, own quota, developer role). Findings never block a merge. |
| `ai_review_status` | _none_ | The latest AI review job with progress counts and characters billed. |

### Delivery (OTA)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_distributions` | _none_ | The project's OTA distributions: branch, format, status, latest version, manifest URL. |
| `publish_release` | `distribution_id`, `confirm` | Publishes the distribution's branch to the CDN – **public**, seen by live apps. Does nothing unless `confirm` is `true`; call it only when the user asked to publish. |

### Branches (`create-own` tokens)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_branches` | _none_ | Every branch with `writable` and `createdByThisToken` flags, plus `baseBranch` and `branchScope`. |
| `create_branch` | `name`, `description?` | Forks a new branch from the base branch. Needs a `create-own` token and the developer role. Name: `^[a-zA-Z0-9_-]+$`, 1–100 chars, not `main`. |
| `compare_with_base` | `branch` | Changed/added/deleted keys of `branch` vs the base, each with per-language values, plus a summary. |
| `get_merge_conflicts` | `branch` | Flat per-key/per-language conflicts of `branch` vs the base; an empty list means it is safe to merge with the default strategy. |
| `review_changes` | `branch?` | A capped (100-key) review packet – added/changed keys with values – plus a `platformUrl` to open in the web app. Call it, then **ask the user** how to review and whether to merge. |
| `merge_branch` | `branch`, `strategy?`, `conflicts?` | Merges a branch you created into the base. Strategies: `overwrite` (default), `keep-newer`, `manual` (pass resolutions from `get_merge_conflicts`), `replace` (destructive). Does **not** delete the branch. Merging into `main` needs an **admin**-role token (`admin_token_required_for_main`), and the QA merge gate may refuse it (`qa_gate_blocked`, never overridable by a token). |
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
2. **Add keys with context.** `upsert_labels { branch: "add-checkout-copy", labels: [...] }`
   writes the new source strings, each with `context` – a `description` of the UI
   element, a `charLimit` when the UI limits the length, `location` as
   `path:line` (or add it later with `set_label_context`).
3. **Translate.** Either translate yourself –
   `get_missing_translations { branch: "add-checkout-copy" }`, check
   `get_glossary` and `find_translation_memory`, fill in the values, and push them
   with `upsert_labels` – or, on a plan with platform AI,
   `auto_translate { branch: "add-checkout-copy" }` and watch it with
   `translation_job_status`.
4. **QA loop.** `run_qa { branch: "add-checkout-copy" }`, fix every error
   (rewrite the value or fix its placeholders), run it again until no errors are
   left, then `check_merge_gate { branch: "add-checkout-copy" }`.
5. **Mark reviewed.**
   `set_labels_status { branch: "add-checkout-copy", keys: [...], status: "approved" }`.
6. **Review + ask.** `review_changes { branch: "add-checkout-copy" }` returns the
   diff and a `platformUrl`. Ask the user whether to review here or on the
   platform, and get their approval – never merge on your own.
7. **Merge.** After approval, `merge_branch { branch: "add-checkout-copy" }` folds
   it into the base (use `get_merge_conflicts` + strategy `manual` if there are
   conflicts). Into `main` this needs an admin-role token; otherwise the user
   merges in the web app.
8. **Clean up.** `delete_branch { branch: "add-checkout-copy" }`.

A `fixed`-scope token skips the branching steps and works directly on its one
branch (steps 2–5).

## Prompts

| Prompt | Arguments | What it does |
| --- | --- | --- |
| `localize_repo` | `target_languages` (comma-separated), `path?` | The full localization workflow: detect the i18n library, find hardcoded strings, propose dotted keys, `create_branch` `agent-<topic>`, upsert source labels with context, replace the strings in code, `auto_translate`, `run_qa` and fix errors, `check_merge_gate`, then summarise – never merging into `main` without approval. |
| `prepare_branch_for_merge` | `branch` | Runs QA on the branch, fixes the errors, reports the merge gate and the changes – without merging. |

In Claude Code they appear as `/mcp__translatize__localize_repo` and
`/mcp__translatize__prepare_branch_for_merge`.

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
- sends and receives **translation data** (label keys, values, statuses, tags,
  translator context, glossary terms, QA findings, release metadata and branch
  metadata) to and from that API in response to tool calls;
- runs entirely locally over stdio, adds **no telemetry or analytics**, and
  contacts no other host. Diagnostics are written to stderr only; your token is
  never written to stdout or logged.

The data you read and write through these tools is handled under the Translatize
privacy policy: **https://translatize.com/en/privacy**.

## License

MIT © SIA "MICRON"
