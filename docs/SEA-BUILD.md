# SEA build — standalone `forma-mcp.exe`

Package this server into a single self-contained Windows executable (Node 20
runtime bundled) so consumers run it **without installing Node.js**. Built with
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg).

The primary consumer is the sibling project
[`bim-orchestrator`](https://github.com/KenLP/bim-orchestrator), which fetches
the exe into `vendor/forma-mcp/` from a GitHub Release. Full end-to-end story:
`bim-orchestrator/docs/PRODUCTION_PACKAGING.md`.

## Build

```bash
npm run sea:build        # tsup CJS bundle + pkg → forma-mcp.exe (node20-win-x64)
npm run sea:build:linux  # → forma-mcp-linux (UNTESTED; Windows is the demo target)
```

Pipeline: `src/index.ts` → `tsup --config tsup.sea.config.ts` (CJS,
`noExternal: [/.*/]` inlines all JS deps; `better-sqlite3` stays external) →
`dist-cjs/index.cjs` (~2.3 MB) → `pkg` → `forma-mcp.exe` (~43 MB).

`package.json` `pkg.assets` embeds `better-sqlite3/build/Release/*.node` so the
native binding ships inside the exe.

## Distribute

The exe is a build artifact — **not committed** (`.gitignore`: `dist-cjs/`,
`forma-mcp.exe`, `forma-mcp-linux`). It is published to a rolling GitHub Release
(tag `forma-mcp-sea`) and fetched by consumers via `gh`.

```bash
npm run sea:publish      # scripts/sea-publish.mjs — idempotent gh release create/upload --clobber
npm run sea:copy         # local dev only: build + copy exe straight into ../MultiAIagents/bim-orchestrator/vendor/forma-mcp/
```

`sea:publish` needs `gh auth login`. First run creates the release; later runs
re-upload the asset with `--clobber`.

## Runtime notes

- The exe loads `.env` from its **current working directory** via dotenv. The
  orchestrator launches it with `cwd = vendor/forma-mcp/`, so credentials live
  in `vendor/forma-mcp/.env` and never touch the orchestrator process.
- **The executable supports `FORMA_PERSISTENCE_MODE=memory` only** (the default).
  `better-sqlite3` is a native addon that cannot be loaded from a packaged
  single-file binary, so the server now refuses to start with a clear message if
  `sqlite` is set under pkg, instead of failing later with "Could not locate
  bindings". Durable persistence requires running from a Node.js install
  (`npx acc-forma-mcp-server` or `node dist/index.js`).
- tsup CJS output is `index.cjs` (not `.js`); the pkg target points at it.
