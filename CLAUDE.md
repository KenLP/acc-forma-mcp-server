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
- **`lastHash` is in-memory** — restart resets it to `'sha256:genesis'`, breaking the chain. `loadLastHashFromFile()` at startup mitigates this (see `docs/REMEDIATION-PLAN.md` Fix 1)
- **Approval tokens and rate counters are in-memory** — single-process deployment only until Fix 6 is done

---

## Known issues (open, see docs/REMEDIATION-PLAN.md)

| ID | Priority | Summary |
|----|----------|---------|
| Fix 1 | P0 | Audit hash chain broken — append and verify use different canonical JSON |
| Fix 2 | P0 | Hub allow-list not enforced for mutation tools (`reviews_create` etc.) |
| Fix 3 | P1 | CI red — 5 `no-unnecessary-type-assertion` lint errors |
| Fix 4 | P1 | `generate:tools-doc` script missing; `test:coverage` dep missing; `dist/scripts/verify-audit.js` missing |
| Fix 5 | P1 | README / SKILL.md still reference `aecdm_query_element_bboxes` (tool renamed to `aecdm_query_element_positions` in PR #2) |
| Fix 6 | P1 | Approval tokens + rate counters in-memory only — lost on restart |
| Fix 7 | P2 | AECDM: category injection risk, pagination overshoot, `listAecdmCategories` parallel probe storm |
| Fix 8 | P2 | HTTP: no jitter, no 401 token invalidation, GraphQL errors not `ApsApiError`, DM SDK bypasses retry layer |

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
- `listAecdmCategories` fires ~60 parallel probes — can hit 429 in production (see Fix 7c)
