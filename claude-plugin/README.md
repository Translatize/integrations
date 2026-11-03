# Translatize plugin for Claude Code

A [Claude Code plugin](https://code.claude.com/docs/en/plugins) that bundles the
[`@translatize/mcp`](https://www.npmjs.com/package/@translatize/mcp) server so
Claude Code can manage your [Translatize](https://translatize.com) translations:
read, search and edit labels with their context, fill missing translations, run QA
checks and preview the merge gate, and work with git-like branches – all from
inside a Claude Code session.

The plugin declares a single stdio MCP server in [`.mcp.json`](.mcp.json) that
Claude Code launches on demand with `npx -y @translatize/mcp`, and two skills.

## Skills

| Skill | When Claude uses it | What it does |
| --- | --- | --- |
| [`localize-repo`](skills/localize-repo/SKILL.md) | You ask to localize or internationalize an app, add languages, or extract hardcoded strings. | Ten steps: detect the i18n library, find hardcoded strings, propose dotted keys, `create_branch` `agent-<topic>`, upsert source labels **with context**, replace the strings in code, `auto_translate`, `run_qa` and fix errors, `check_merge_gate`, then summarise. It never merges into `main` without your approval. |
| [`translatize-strings`](skills/translatize-strings/SKILL.md) | Any time Claude adds or changes user-visible text. | The day-to-day rules: no hardcoded UI strings, keys created through the MCP server with a description and char limit, dotted key names, work on a branch, QA before merge. |

The same rules can live in your repository for every coding agent:
`npx @translatize/cli init --agents` writes them into a marked section of
`AGENTS.md` (and `CLAUDE.md`, when it exists).

The server also offers two MCP prompts, `localize_repo` and
`prepare_branch_for_merge`, which show up as slash commands in clients that
support prompts.

## Requirements

- **Node.js ≥ 18.17** on the machine running Claude Code (so `npx` can fetch and
  run the server).
- The **`@translatize/mcp` package**, published to npm – `npx` downloads it the
  first time the server starts. (To run against a local checkout instead, use the
  local install below.)
- A **Translatize API token** (an `mcni_...` string) exported as the
  `TRANSLATIZE_API_TOKEN` environment variable. Create one under **Project
  Settings → Integrations** at [app.translatize.com](https://app.translatize.com).
  Each token is bound to one project and one base branch.

The `${TRANSLATIZE_API_TOKEN}` placeholder in `.mcp.json` is expanded from the
environment Claude Code runs in, so the secret never lives in the plugin. Export
it in your shell (or your OS keychain / project env) before starting Claude Code:

```bash
export TRANSLATIZE_API_TOKEN=mcni_xxx
```

To point at a self-hosted API, also export `TRANSLATIZE_API_URL` (default
`https://api.translatize.com/v1`) and add it to the `env` block of `.mcp.json`.

## Install

### From a marketplace

Once the plugin is listed in a marketplace repository, add the marketplace and
install:

```
/plugin marketplace add <owner>/<repo>
/plugin install translatize@<marketplace-name>
```

A minimal marketplace that serves this plugin looks like this
(`.claude-plugin/marketplace.json` in the marketplace repo):

```json
{
  "name": "translatize",
  "owner": { "name": "SIA \"MICRON\"", "url": "https://translatize.com" },
  "plugins": [
    {
      "name": "translatize",
      "source": "./integrations/claude-plugin",
      "description": "Manage Translatize translations from Claude Code."
    }
  ]
}
```

Adjust `source` to wherever the plugin directory lives in that repo (a relative
path, or a separate git/URL source). See
[plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).

### Directly (local / development)

Point Claude Code at this directory – no marketplace required:

```bash
claude --plugin-dir ./integrations/claude-plugin
```

If you are iterating on the plugin, run `/reload-plugins` after edits.

## Verify it loaded

Start Claude Code and confirm the server is connected:

```
/mcp
```

You should see the `translatize` server and its tools. Then try a prompt such as
"What languages does this Translatize project support, and how complete is each
one?", or "Localize the checkout page into Latvian and German" to run the
`localize-repo` skill. The full tool list and agentic workflow are documented in
the [`@translatize/mcp` README](https://www.npmjs.com/package/@translatize/mcp).

Validate the plugin after any change:

```bash
claude plugin validate integrations/claude-plugin
```

## Privacy

The bundled server talks only to the Translatize API using your token and adds no
telemetry. See the
[server's privacy policy](https://translatize.com/en/privacy).

## License

MIT © SIA "MICRON"
