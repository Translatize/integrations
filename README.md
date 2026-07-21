# Translatize integrations

Client-side tooling for the Translatize integration API (the machine-token API
authenticated with `Authorization: Bearer mcni_...`). This is an npm workspace root
that is intentionally separate from the apps in the repo – it has the **only**
`package.json` with `workspaces`, and the repo root stays package.json-free.

## Packages

| Package | Directory | Status | What it is |
| --- | --- | --- | --- |
| `@translatize/core` | [`core/`](core/) | available | Zero-dependency TypeScript SDK for the integration API (client + flatten/unflatten helpers). The shared foundation everything else builds on. |
| `@translatize/cli` | [`cli/`](cli/) | available | Command-line tool (`translatize init/pull/push/status`) built on `@translatize/core`. Syncs translations from CI with git-like branching. |
| `@translatize/mcp` | [`mcp/`](mcp/) | available | Model Context Protocol server exposing the API to AI agents (Claude Code, Cursor, ...) over stdio, built on `@translatize/core`. |

### CI templates

Two ready-to-use CI integrations complement the packages. They shell out to the
`@translatize/cli` (`npx @translatize/cli ...`) rather than being npm packages,
so you consume them as workflow/pipeline config, not via `npm install`:

| Template | Home | What it is |
| --- | --- | --- |
| GitHub Action | [github.com/Translatize/sync-action](https://github.com/Translatize/sync-action) | Composite action (`translatize/sync-action`) wrapping the CLI's `pull`/`push`/`status` for GitHub workflows. |
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

The `@translatize/core`, `@translatize/cli`, and `@translatize/mcp` packages are
published to npm under the **@translatize** scope. Publishing is **manual** –
nothing here publishes automatically. To cut a release, build first, then
`npm publish --access public` from the individual package directory (or
`npm publish --workspaces`).
