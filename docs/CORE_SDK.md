# Core SDK — `acc-forma-mcp-server/core`

The typed APS client layer of this repo is consumable as a library, without starting the MCP server and **without any `APS_*`/`SSA_*`/`FORMA_*` env vars**. This is the shared kernel for sibling products in `D:\AIProjects\CDE Apps` (n8n connector pack, CDE Pulse, gateways).

```ts
import {
  SsaAuthProvider,      // JWT-bearer bot identity (headless automation)
  TwoLeggedAuthProvider,
  issuesApi, aecdmApi, dmApi, mcApi, mdApi, reviewsApi, adminApi, pushpinApi,
  apsRequest, apsGraphQL, setDefaultApsRegion,
  ApsApiError, ApsGraphQLError,
  stripBPrefix, addBPrefix,
} from 'acc-forma-mcp-server/core';
```

## Why a subpath, not a separate package

See [ADR 0002](adr/0002-core-subpath-export.md). Short version: the MCP server's contract with consumers (BIM Orchestrator, Claude clients) is the **built artifact** (`dist/index.js` / `forma-mcp.exe` over stdio) — a subpath export adds a second build entry without touching that artifact, moving any file, or forking version history. We extract a real `@cde-apps/core` package only when ≥2 shipping products make the coupling hurt.

## Consuming from a sibling project

```json
// package.json of your app (e.g. under D:\AIProjects\CDE Apps\apps\<name>)
{
  "type": "module",
  "dependencies": {
    "acc-forma-mcp-server": "file:../../../acc-forma-mcp-server"
  }
}
```

`npm install` symlinks the repo; `import ... from 'acc-forma-mcp-server/core'` resolves through the `exports` map to `dist/core.js` + `dist/core.d.ts` (full types). **Run `npm run build` in this repo after pulling changes** — consumers see `dist/`, not `src/`.

Working example: [`CDE Apps/examples/core-consumer`](../../CDE%20Apps/examples/core-consumer/main.mjs).

## Auth: explicit config first, env fallback second

Auth providers accept an explicit config object — this is the primary pattern for library consumers (n8n credential stores, CLI flags, secret managers). Every field falls back to the matching env var only if not provided:

```ts
// SSA — full write access (Issues, Reviews, AECDM). The bot identity.
const auth = new SsaAuthProvider(
  ['data:read', 'data:write', 'account:read'],
  {
    clientId: creds.clientId,          // APS_CLIENT_ID
    clientSecret: creds.clientSecret,  // APS_CLIENT_SECRET
    ssaId: creds.ssaId,                // SSA_ID
    ssaKeyId: creds.ssaKeyId,          // SSA_KEY_ID
    privateKey: creds.pemContent,      // PEM string directly (n8n pattern)
    // ...or ssaKeyPath: '/path/key.pem' (SSA_KEY_PATH) when a file is fine
  },
);

// 2LO — Account Admin reads, Webhooks, OSS only (no Issues/Reviews writes)
const auth2lo = new TwoLeggedAuthProvider(['account:read'], {
  clientId: creds.clientId,
  clientSecret: creds.clientSecret,
});
```

Missing credentials throw at construction with the exact field names — never at first request.

`setDefaultApsRegion('EMEA')` sets the `x-ads-region` fallback once per process (default `'US'`, or `APS_REGION` if set); individual calls can still pass `options.region`.

## API domains (namespaced)

Domains are exported as namespaces so same-named types in different domains (e.g. `Vec3` in both `aecdmApi` and `pushpinApi`) can never collide:

| Namespace | Domain | Highlights |
|---|---|---|
| `issuesApi` | ACC Issues v2 | `listIssues`, `createIssue`, `updateIssue` (sparse PATCH), comments, attachments, custom attrs |
| `reviewsApi` | ACC Reviews | `listReviews`, `createReview`, `transitionReview`, container-id resolution |
| `aecdmApi` | AEC Data Model (GraphQL) | `queryElementsByCategory`, `queryElementPositions` (metres!), `listAecdmCategories` |
| `dmApi` | Data Management | hubs/projects/folders/items/versions, `getProjectContainerIds` |
| `mcApi` | Model Coordination | `listModelSets`, `getClashResults`, `resolveClashes` (pure join, unit-tested) |
| `mdApi` | Model Derivative | `getMdManifest`, `getMdProperties` (fields/group_by), `aggregateMdProperties`, `extractDocsViewables` |
| `adminApi` | Account Admin | projects/users/companies (2LO) |
| `pushpinApi` | Issue pushpins | `aecdmPositionToViewer`, `buildPushpin`, `buildRasterPushpin`, coordinate transforms |

All functions take an `AuthProvider` as first argument — auth strategy stays the caller's choice. Domain-specific gotchas (globalOffset, viewableId vs guid, AECDM level trap, MC product access) are documented in [CLAUDE.md](../CLAUDE.md); those notes apply verbatim to core consumers.

## What is NOT in core (by design)

- **Safety layer** (`dry-run`, approval tokens, audit hash-chain, allow-lists, rate governance) — this is MCP-server behavior wired through `_wrap.ts` and configured via `FORMA_*` env vars. If your app needs write-guarding, call the MCP server itself, or wait for the safety-wrapper extraction (Roadmap Tier 3, "AEC MCP Trust Registry").
- **`config/env.ts`** — deliberately excluded; it throws at import when APS vars are absent.
- **Tool definitions / MCP transport** — consumers talk to APS, not to MCP.

## The env-free invariant (do not break)

**Nothing reachable from `src/core.ts` may import `config/env.js`.** That module validates env at import time and throws — one careless import makes core unusable for every credential-store consumer.

Enforced by [`tests/unit/core/env-free.spec.ts`](../tests/unit/core/env-free.spec.ts) (its `vi.mock` factory throws if `config/env.js` enters the import graph). If you add a module to core:

1. It must take config via parameters/constructor, falling back to `process.env` reads per-field (see `SsaAuthConfig`).
2. Re-export it from `src/core.ts` — flat for infra, `export * as <domain>Api` for API clients.
3. `npm run test` — the guard spec fails on violations.

## Versioning & stability

- The core surface follows this package's semver. Until `1.0.0`, breaking changes are allowed but must be listed in [CHANGELOG.md](../CHANGELOG.md) under a **Core SDK** heading.
- The MCP tool schemas and the core exports are **independent surfaces** — renaming a core function does not touch MCP clients, and vice versa.
