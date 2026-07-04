# ADR 0002: Core SDK as a subpath export, not a separate package

**Status:** Accepted
**Date:** 2026-07-04

## Context

The CDE Apps portfolio (n8n connector pack, CDE Pulse cross-CDE extractor, gateways — see `D:\AIProjects\CDE Apps\ROADMAP.md`) needs the typed APS client layer that lives in this repo: auth providers (SSA/2LO), `apsRequest`/`apsGraphQL` with retry/backoff, and the eight `src/apis/*` domain clients with their hard-won API knowledge (pushpin transforms, clash-file joins, MD group_by).

Two extraction strategies were considered:

1. **Monorepo split** — move `src/apis` + `src/auth` + `src/http` into a `@cde-apps/core` package; this repo depends on it.
2. **Subpath export** — add `src/core.ts` as a second build entry; publish it via the `exports` map as `acc-forma-mcp-server/core`. No file moves.

Key constraint: BIM Orchestrator consumes this server **as a built artifact** (`vendor/forma-mcp/forma-mcp.exe` or `dist/index.js` over stdio — see its `mcp_clients/forma.py` and our `scripts/sea-copy.mjs` / GitHub release `forma-mcp-sea`). The contract surface is tool names/schemas + artifact layout + `.env` location, not TypeScript module structure.

A blocking discovery: `config/env.ts` validates and **throws at import time** when `APS_CLIENT_ID`/`APS_CLIENT_SECRET` are absent, and `auth/ssa.ts`, `auth/two-legged.ts`, `http/client.ts` imported it. Any library surface re-exporting them would crash consumers that supply credentials from their own stores (n8n credentials UI) instead of env vars.

## Decision

**Subpath export (option 2)**, with an env-decoupling refactor:

- `src/core.ts` re-exports the public surface. API domains are namespaced (`export * as issuesApi`) so same-named types across domains (e.g. `Vec3` in `aecdm` and `pushpin`) cannot collide or be silently dropped by star re-exports.
- Auth providers take explicit config objects (`SsaAuthConfig`, `TwoLeggedAuthConfig`) with per-field `process.env` fallback; they no longer import `config/env.js`. The MCP server path is unchanged because `src/index.ts` imports/validates `config/env.ts` (which also runs dotenv) before constructing providers.
- `http/client.ts` keeps a module-local default region + `setDefaultApsRegion()`; `index.ts` propagates `env.APS_REGION` at startup.
- **Invariant:** nothing reachable from `src/core.ts` may import `config/env.js`. Guarded by `tests/unit/core/env-free.spec.ts` (mock factory throws if the module enters the import graph).
- Build: second tsup entry + `dts` for `core.ts` only; `tsup.sea.config.ts` (exe pipeline) still bundles `index.ts` alone.

## Consequences

- `dist/index.js`, `forma-mcp.exe`, tool schemas, `.env` handling: byte-level behavior unchanged — verified by the full test suite (143 passing), a no-env import smoke of `dist/core.js`, a normal-startup smoke (42 tools registered), and an end-to-end `file:` consumer (`CDE Apps/examples/core-consumer`).
- Sibling apps consume via `"acc-forma-mcp-server": "file:../../../acc-forma-mcp-server"` — one repo to build, no publish step, no version skew.
- Publishing to npm later requires either publishing this whole package or bundling core into the consumer at build time (the plan for n8n community nodes, whose registry deps must resolve from npm).
- Revisit (extract a real `@cde-apps/core` monorepo package) when **≥2 shipping products** consume core AND one of: version skew bites, npm publish becomes unavoidable, or core churn forces constant rebuild coordination. The extraction will be invisible to BIM Orchestrator for the same artifact-contract reason.
