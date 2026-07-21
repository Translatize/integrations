# @translatize/cli

Translation management with git-like branching – sync your app's translations
from CI.

`translatize` is the command-line client for [Translatize](https://translatize.com).
It downloads a branch's translations into per-language JSON files (`pull`), sends
your local source keys back (`push`), and reports drift between the two
(`status`) so a pull request can be gated on translation completeness. It is
built on [`@translatize/core`](https://www.npmjs.com/package/@translatize/core)
and talks to the machine-token integration API.

Requires Node.js >= 18.17.

## Install

```bash
npm install -D @translatize/cli
```

The binary is named `translatize`. Run it with `npx translatize <command>`, or
add it to your npm scripts.

## Quickstart

```bash
# 1. Scaffold translatize.config.json (records your project + file layout)
npx translatize init

# 2. Provide a branch-bound API token (see "Authentication" below)
export TRANSLATIZE_API_TOKEN=mcni_xxx

# 3. Download translations into locales/<lang>.json
npx translatize pull
```

`init` writes a `translatize.config.json` you commit to your repo. The token is
**never** written to that file – it is read from the environment or `--token` at
run time.

## Authentication

The CLI authenticates with an **API token** (a string beginning with `mcni_`),
not your login. Create one under **Project Settings → Integrations** at
[app.translatize.com](https://app.translatize.com).

A token is **bound to a single project and a base branch**. By default
`translatize` operates on that bound branch. A token whose scope is `create-own`
(an "agent" token) may also target branches **it created** – pass `--branch <name>`
(or set `branch` in the config) to operate on one of them. Naming a branch the
token is not allowed to touch fails with a `branch_not_allowed` error that lists
the branches the token may target. To sync an arbitrary existing branch, mint a
token bound to it.

The token is resolved in this order:

1. the `--token <mcni_...>` flag, then
2. the `TRANSLATIZE_API_TOKEN` environment variable.

If neither is set, the command exits with a usage error. Keep the token out of
your config file and out of version control; in CI, store it as a secret.

## Configuration

`translatize.config.json` lives at the root of your project (or anywhere you
point `--config` at). File patterns are resolved relative to the config file's
directory.

```json
{
  "apiUrl": "https://api.translatize.com/v1",
  "projectId": "your-project-id",
  "format": "json-nested",
  "files": "locales/{lang}.json",
  "namespace": "app",
  "branch": "feature-x"
}
```

| Field | Required | Description |
| --- | --- | --- |
| `apiUrl` | no | API base URL including the `/v1` segment. Defaults to `https://api.translatize.com/v1`. |
| `projectId` | no | The project's id. May be left empty – the CLI derives it from the token at run time. Set it to pin the project (a mismatch with the token is reported). |
| `format` | yes | On-disk shape: `json-nested` (dotted keys become nested objects) or `json-flat` (dotted keys stay flat). |
| `files` | yes | Path pattern for each language file. Must contain the `{lang}` placeholder, e.g. `locales/{lang}.json`. |
| `namespace` | no | Restrict every operation to keys beginning with `"<namespace>."`. |
| `branch` | no | Default branch for `pull`/`push`/`status`. Must be in the token's allowed set. Overridden by `--branch`. When omitted, commands use the token's bound branch. |

### `json-nested` vs `json-flat`

The API stores keys in flat, dotted form (`app.nav.home`). The `format` setting
controls how they are written to disk:

```jsonc
// json-nested                     // json-flat
{                                  {
  "app": {                           "app.nav.home": "Home",
    "nav": { "home": "Home" },       "app.title": "Hello"
    "title": "Hello"               }
  }
}
```

Both are read back losslessly. If your keys cannot be nested (a key is used as
both a value and a parent, e.g. both `a` and `a.b` exist), `json-nested`
serialization fails with a message telling you to switch to `json-flat`.

Files are written with keys sorted and a trailing newline, so re-running `pull`
produces stable, diff-friendly output.

## Commands

Every command accepts these global flags:

| Flag | Description |
| --- | --- |
| `-c, --config <path>` | Path to the config file. Default `translatize.config.json`. |
| `--token <token>` | API token, overriding `TRANSLATIZE_API_TOKEN`. |
| `--api-url <url>` | API base URL, overriding the config value. |

### `translatize init`

Create `translatize.config.json`. Refuses to overwrite an existing file unless
`--force` is passed. If a token is available it calls the API to validate it and
prints the project name, bound branch, role, and configured languages.

| Flag | Description |
| --- | --- |
| `--project-id <id>` | Project id to record in the config. |
| `--files <pattern>` | File pattern with a `{lang}` placeholder. Default `locales/{lang}.json`. |
| `--format <format>` | `json-nested` (default) or `json-flat`. |
| `--force` | Overwrite an existing config file. |

### `translatize pull`

Download the branch and write one file per project language at the `files`
pattern, creating parent directories as needed. A key with an empty or missing
value for a language is **omitted** from that language's file. If `namespace` is
set, only keys under that namespace are pulled.

| Flag | Description |
| --- | --- |
| `--branch <name>` | Branch to pull. Overrides the config `branch` field and the token's bound branch. Must be in the token's allowed set. |
| `--dry-run` | Report the per-file changes (new file / keys added / changed / removed locally) without writing anything. |
| `--json` | Emit machine-readable JSON instead of the human summary. |

### `translatize push`

Read each language file, compare it with the branch, and upload **only new and
changed keys**. Values are assembled per key across all language files. Requests
are chunked automatically to stay within the server's batch limit.

Translatize **never deletes keys via push**. Keys that exist on the branch but
not locally are reported as an informational note and left untouched. A missing
language file produces a warning and is skipped.

Exits `1` if the server rejects any key (each failure is listed with its error
code).

| Flag | Description |
| --- | --- |
| `--branch <name>` | Branch to push to. Overrides the config `branch` field and the token's bound branch. Must be in the token's allowed set. |
| `--dry-run` | Print the pending create/update list without sending anything. |
| `--json` | Emit machine-readable JSON. |

### `translatize status`

Compare local files against the branch without changing either side – this is
the CI gate. It prints per-language completeness (non-empty translations over
total branch keys) and the counts of keys that are only local, only remote, or
whose values differ (with up to 10 example keys each).

| Flag | Description |
| --- | --- |
| `--branch <name>` | Branch to compare against. Overrides the config `branch` field and the token's bound branch. Must be in the token's allowed set. |
| `--fail-on-missing` | Exit `1` if any language is missing translations. |
| `--fail-on-diff` | Exit `1` if local differs from the branch in any way. |
| `--json` | Emit machine-readable JSON. |

Without a `--fail-*` flag, `status` reports differences but still exits `0`.

## Selecting a branch

`pull`, `push`, and `status` all accept `--branch <name>`. The branch is resolved
in this order:

1. the `--branch <name>` flag, then
2. the `branch` field in `translatize.config.json`, then
3. the token's bound (base) branch.

A standard token can only ever act on its bound branch, so `--branch` must name
that same branch. A **`create-own` agent token** may additionally target any
branch **it created** – point `--branch` (or the config `branch` field) at one of
them to pull, push, or diff there. Targeting a branch outside the token's allowed
set fails with a `branch_not_allowed` error listing the branches the token may
use.

## Use in CI

`status` is designed to fail a build when translations fall behind. A GitHub
Actions job that blocks merges on missing translations:

```yaml
name: translations
on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx translatize status --fail-on-missing
        env:
          TRANSLATIZE_API_TOKEN: ${{ secrets.TRANSLATIZE_API_TOKEN }}
```

To push newly added source keys from a merge to `main`, run
`npx translatize push` in a job with a token bound to that branch. Use `--json`
if you want to parse the result in a later step.

## Machine-readable output

`pull`, `push`, and `status` accept `--json` and print a stable JSON document to
stdout (human output goes to stdout too; warnings and errors go to stderr). Colors
are disabled automatically when stdout is not a TTY or when `NO_COLOR` is set, so
piped and CI logs stay plain.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (including `status` differences when no `--fail-*` gate is set). |
| `1` | A gate tripped, a `push` had server-side failures, or an API request failed. |
| `2` | Usage or configuration error (bad flags, missing/invalid config, no token). |

## License

MIT © SIA "MICRON"
