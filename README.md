# Translatize integrations

Client-side tooling for the Translatize integration API (the machine-token API
authenticated with `Authorization: Bearer mcni_...`). This is an npm workspace root
that is intentionally separate from the apps in the repo – it has the **only**
`package.json` with `workspaces`, and the repo root stays package.json-free.

## Packages

| Package | Directory | Status | What it is |
| --- | --- | --- | --- |
| `@translatize/core` | [`core/`](core/) | available | Zero-dependency TypeScript SDK for the integration API (client + flatten/unflatten helpers). The shared foundation everything else builds on. |
| `@translatize/cli` | [`cli/`](cli/) | available | Command-line tool (`translatize init/pull/push/status/qa/screenshots upload/release`) built on `@translatize/core`. Syncs translations from CI with git-like branching, gates on QA, uploads screenshot captures and publishes OTA releases. |
| `@translatize/mcp` | [`mcp/`](mcp/) | available | Model Context Protocol server exposing the API to AI agents (Claude Code, Cursor, ...) over stdio, built on `@translatize/core`: 28 tools and 2 workflow prompts. |
| `@translatize/playwright` | [`playwright/`](playwright/) | new in 0.2.0 | Captures screenshots with text positions from Playwright tests, for `translatize screenshots upload`. |
| `@translatize/ota` | [`ota/`](ota/) | new in 0.2.0 | Zero-dependency over-the-air client (browser, React Native, Node) with an i18next backend. |
| `@translatize/ota-worker` | [`ota-worker/`](ota-worker/) | private | The Cloudflare Worker that serves OTA releases. Deployed with `wrangler`, not published. |
| `@translatize/github-app` | `github-app/` | private | The GitHub App service (container). Not published. |

The Claude Code plugin in [`claude-plugin/`](claude-plugin/) bundles the MCP
server plus two skills (`localize-repo`, `translatize-strings`).

### CI templates

Two ready-to-use CI integrations complement the packages. They shell out to the
`@translatize/cli` (`npx @translatize/cli ...`) rather than being npm packages,
so you consume them as workflow/pipeline config, not via `npm install`:

| Template | Home | What it is |
| --- | --- | --- |
| GitHub Action | [github.com/Translatize/sync-action](https://github.com/Translatize/sync-action) | Composite action (`translatize/sync-action`) wrapping the CLI's `pull`/`push`/`status`/`qa` for GitHub workflows. |
| GitLab CI | [gitlab.com/translatize/gitlab](https://gitlab.com/translatize/gitlab) | CI/CD Catalog component (`templates/translatize.yml`) plus copy-paste `.gitlab-ci.yml` jobs. |

## Development

```bash
cd integrations
npm install        # installs every workspace and hoists dev deps
npm run build      # builds each workspace that defines a build script
npm test           # runs each workspace's test suite
```

Requires Node.js >= 18.17 (native `fetch`, `node:test`).

## Publishing

The `@translatize/core`, `@translatize/cli`, `@translatize/mcp`,
`@translatize/ota` and `@translatize/playwright` packages are published to npm
under the **@translatize** scope, in lockstep versions. Publishing is **manual** –
nothing here publishes automatically. Follow [PUBLISHING.md](PUBLISHING.md):
build first, then `npm publish --access public` per package, core first. Don't use
`npm publish --workspaces` – it would also try the private packages.
