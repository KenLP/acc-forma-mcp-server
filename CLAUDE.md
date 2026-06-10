# CLAUDE.md — acc-forma-mcp-server

MCP server exposing Autodesk Construction Cloud (ACC) / Forma APIs to Claude.
TypeScript, Node.js ≥ 20, ESM only.

---

## Common commands

```bash
npm run build          # tsup → dist/
npm run typecheck      # tsc --noEmit (no emit, just type check)
npm run lint           # eslint src tests
npm run test           # vitest run (unit only)
npm run lint -- --fix  # auto-fix safe lint errors
```

CI uses **pnpm** (`pnpm install --frozen-lockfile`). Locally npm works fine for build/test/lint.
`pnpm` may not be in PATH — use npm for local dev unless you need lockfile work.

---

## Architecture

```
src/
  index.ts          # entrypoint — wires MCP server
  server.ts         # registers all tools via _registry
  config/env.ts     # zod-validated env schema (all env vars here)
  auth/             # SSA + 2LO providers
  http/client.ts    # apsRequest() + apsGraphQL() with retry/backoff
  apis/             # thin wrappers over APS REST/GraphQL (no business logic)
  tools/
    _types.ts       # ReadToolDef / MutationToolDef interfaces
    _wrap.ts        # wrapReadTool / wrapMutationTool — ALL safety is here
    _registry.ts    # lists every tool; server.ts iterates this
    <domain>/       # one file per tool
  safety/           # each guardrail as its own module
    allowlist.ts    # FORMA_ALLOWED_HUBS / FORMA_ALLOWED_PROJECTS
    readonly-mode.ts
    rate-governance.ts
    dry-run.ts
    approval.ts
    audit-log.ts    # JSONL append + SHA-256 hash chain
    hash-chain.ts   # computeHash() + verifyChain()
    business-rules.ts
  utils/
    redact.ts       # strips tokens/keys before audit write
```

### Adding a new tool

1. Create `src/tools/<domain>/<verb>.ts` — export a `ReadToolDef` or `MutationToolDef`
2. Add it to `src/tools/_registry.ts`
3. Mutation tools: implement `getProjectId` (and `getHubId` if the tool has a `hub_id` field)
4. Run `npm run typecheck && npm run lint && npm run test`

### Mutation tool pipeline (enforced by `wrapMutationTool`)

```
auth-mode check → hub allow-list → project allow-list → readonly check
  → rate governance → business rules → buildPreview()
  → [if dry_run=true] return preview + approval_token  ← STOP
  → verifyAndConsumeToken()
  → execute()
  → audit log
```

Never bypass `wrapMutationTool` — adding a mutation tool that calls APS directly skips all guardrails.

---

## Key invariants

- **`dry_run` defaults to `true`** — no mutation executes without explicit `dry_run=false` + valid token
- **Approval tokens are payload-bound** — the token hash includes the exact execute payload; changing any input field after `dry_run=true` invalidates the token
- **Audit entries are hash-chained** — `this_hash = sha256(prevHash + canonical_json_of_entry_without_this_hash)`. `verifyChain` checks both hash validity and `prev_hash` adjacency
- **`lastHash` is in-memory** — restart resets it to `'sha256:genesis'`, breaking the chain. `loadLastHashFromFile()` at startup mitigates this by restoring the last known hash from the audit file
- **Approval tokens and rate counters are in-memory** — single-process deployment only (durable store not yet implemented)

---

## Known limitations

| Area | Status |
|------|--------|
| Approval tokens + rate counters | In-memory only — lost on restart, not shared across processes. Single-process deployment required. Startup logs a WARN. |
| `FORMA_AUDIT_FAIL_CLOSED` | Not yet implemented — audit write failure is logged but does not block the mutation. |
| Circuit breaker | No open/half-open circuit for APS endpoints — consecutive 5xx will keep retrying with backoff. |
| 3LO auth | Not implemented (Phase 3). |

---

## Env vars (key ones)

| Var | Default | Notes |
|-----|---------|-------|
| `APS_AUTH_MODE` | `ssa` | `ssa` \| `2lo`. Tools declare which modes they support |
| `SSA_KEY_PATH` | — | Absolute path to PEM file. On Windows: `C:\Users\...\forma-ssa.pem` |
| `FORMA_MUTATION_MODE` | `preview_required` | `preview_required` \| `client_approval_only` \| `readonly` |
| `FORMA_ALLOWED_HUBS` | `*` | Comma-separated hub IDs or `*` |
| `FORMA_ALLOWED_PROJECTS` | `*` | Comma-separated project IDs or `*` |
| `FORMA_AUDIT_DIR` | `~/.acc-forma-mcp/audit` | Daily JSONL files written here |
| `FORMA_AUDIT_INDEX` | `none` | `none` \| `sqlite` |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |

Full schema: `src/config/env.ts`

---

## Test layout

```
tests/unit/
  safety/         # audit, hash-chain, allowlist, rate-governance
  tools/
    aecdm/        # query-element-positions transform
    issues/       # subtype resolution, linked-documents
```

No mocks of the APS HTTP layer — unit tests exercise pure logic (transforms, validators, hash functions).
Integration tests (in `tests/integration/`, skipped locally) require real APS credentials and run only on push to `main` in CI.

---

## AECDM notes

- AECDM hub IDs ≠ DM hub IDs — always use `aecdm_list_hubs`, never reuse DM IDs
- Filter DSL requires single quotes: `property.name.category=='Walls'`
- `aecdm_query_element_positions` returns an *origin point* (first geometry piece transform), **not** an AABB — AECDM does not expose AABBs directly
- `geometryDataByElements` is Public Beta — may change; elements without geometry return `position: null`
- `listAecdmCategories` fires ~60 probes with concurrency capped at 8 to prevent 429 storms
