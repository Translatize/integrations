# Translatize plugin for Claude Code

A [Claude Code plugin](https://code.claude.com/docs/en/plugins) that bundles the
[`@translatize/mcp`](https://www.npmjs.com/package/@translatize/mcp) server so
Claude Code can manage your [Translatize](https://translatize.com) translations:
read, search and edit labels, find and fill missing translations, and work with
git-like branches – all from inside a Claude Code session.

The plugin declares a single stdio MCP server in [`.mcp.json`](.mcp.json) that
Claude Code launches on demand with `npx -y @translatize/mcp`.

## Requirements

- **Node.js ≥ 18.17** on the machine running Claude Code (so `npx` can fetch and
  run the server).
- The **`@translatize/mcp` package published to npm** – `npx` downloads it the
  first time the server starts. Until it is published, install locally instead
  (see below).
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
one?". The full tool list and agentic workflow are documented in the
[`@translatize/mcp` README](https://www.npmjs.com/package/@translatize/mcp).

## Privacy

The bundled server talks only to the Translatize API using your token and adds no
telemetry. See the
[server's privacy policy](https://translatize.com/en/privacy).

## License

MIT © SIA "MICRON"
