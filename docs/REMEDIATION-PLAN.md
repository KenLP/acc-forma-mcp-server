# Remediation Plan

**Reviewed:** 2026-06-10  
**Reviewer:** Code review (Claude Opus 4.7) + manual source verification  
**Status:** Sprint 1 in progress

---

## Summary

Project has a solid safety foundation (dry-run, approval tokens, allow-list, audit log, redaction) but is not yet production-ready. Four blockers must be fixed before any production deployment:

1. Audit hash chain is broken — append and verify use different canonical forms; adjacency not checked
2. Hub allow-list is not enforced for mutation tools with `hub_id`
3. CI is red — 5 lint errors block every PR
4. README advertises removed/renamed tooling and non-existent scripts

---

## Sprint 1 — Blockers (target: 1–2 days)

### Fix 1 — Audit hash chain correctness (P0)

**Root cause:** `audit-log.ts:82` passes `partial` (which already contains `prev_hash`) into `computeHash(lastHash, partial)`. Inside `computeHash`, `prevHash` is prepended again via `{ prevHash, ...sortedEntry }` — so `prev_hash` appears twice in the canonical JSON written to disk. When `verifyChain` reads the file it destructures `{ prev_hash, this_hash, ...rest }` and calls `computeHash(prev_hash, rest)` — canonical JSON no longer contains the duplicate field, so the hash never matches. **Every entry in every audit log written so far will fail verification.**

Additionally, `verifyChain` does not check `entries[i].prev_hash === entries[i-1].this_hash`, so deleting a line from the middle of a log file goes undetected.

**Files:** `src/safety/audit-log.ts`, `src/safety/hash-chain.ts`

**Changes:**
- `audit-log.ts:82` — strip `prev_hash` from `partial` before hashing:
  ```ts
  const { prev_hash: _ph, ...restForHash } = partial;
  const thisHash = computeHash(lastHash, restForHash as Record<string, unknown>);
  ```
  This makes the canonical form identical to what `verifyChain` reconstructs.
- `hash-chain.ts:verifyChain` — add adjacency check:
  ```ts
  const expectedPrevHash = i === 0 ? 'sha256:genesis' : entries[i - 1]!.this_hash;
  if (entry.prev_hash !== expectedPrevHash) {
    return { valid: false, first_invalid_index: i };
  }
  ```
- `audit-log.ts` — add `loadLastHashFromFile()` called at startup: read the last line of today's (or most recent) audit file, parse `this_hash`, set module-level `lastHash`. Prevents chain break across restarts.
- Optional/later: add `FORMA_AUDIT_FAIL_CLOSED` env flag — when `true`, audit write failure throws instead of swallowing, blocking the mutation.

**Tests to add:** `tests/unit/safety/audit-chain.spec.ts`
- Append 3 entries → `verifyChain` returns `valid: true`
- Tamper content of entry[1] → `valid: false, first_invalid_index: 1`
- Delete entry[1] (gap in `prev_hash`) → `valid: false, first_invalid_index: 2`

---

### Fix 2 — Hub allow-list enforcement for mutations (P0)

**Root cause:** `_wrap.ts:wrapMutationTool` (line 139) only calls `checkProjectAllowed`. `reviews_create` (and potentially future tools) carry `hub_id` in their input schema, but `checkHubAllowed` is never called in the mutation path.

**Files:** `src/tools/_types.ts`, `src/tools/_wrap.ts`, `src/tools/reviews/create.ts`

**Changes:**
- `_types.ts` — add optional field to `MutationToolDef`:
  ```ts
  getHubId?: (input: z.infer<TSchema>) => string | undefined;
  ```
- `_wrap.ts:~139` — enforce hub allow-list:
  ```ts
  const hubId = tool.getHubId?.(input);
  if (hubId) checkHubAllowed(hubId);
  if (projectId) checkProjectAllowed(projectId);
  ```
- `reviews/create.ts` — implement `getHubId`:
  ```ts
  getHubId: (input) => input.hub_id,
  ```
- Audit any other mutation tools that accept `hub_id` and add `getHubId` there too.

**Tests to add:** in existing `_wrap` or reviews test file
- `FORMA_ALLOWED_HUBS=hub-A`, call `reviews_create` with `hub_id=hub-B` → result `isError`, stage `denied_allowlist`

---

### Fix 3 — CI lint (P1)

**Root cause:** 5 `@typescript-eslint/no-unnecessary-type-assertion` errors introduced across recent commits. CI runs `pnpm run lint` and fails on these.

**Files:**
- `src/apis/data-management.ts:86`
- `src/safety/audit-log.ts:82` *(also changed by Fix 1)*
- `src/tools/_wrap.ts:150`
- `src/tools/reviews/list.ts:34`
- `tests/unit/tools/issues/linked-documents.spec.ts:111`

**Changes:** Remove the unnecessary `as` casts — TypeScript already narrows the type at each site. Run `npm run lint -- --fix` to auto-fix, then review the diff.

**Verify:** `npm run lint && npm run typecheck && npm run test` all pass locally before pushing.

---

## Sprint 2 — Tooling & documentation (target: 1 day)

### Fix 4 — Broken package.json scripts (P1)

| Script | Problem | Resolution |
|--------|---------|-----------|
| `generate:tools-doc` | Points to `scripts/generate-tools-doc.ts` which does not exist | Either create the script, or remove the entry from `package.json` |
| `test:coverage` | Requires `@vitest/coverage-v8` which is not in `devDependencies` | Either add the dep (`pnpm add -D @vitest/coverage-v8`), or remove the script |
| `dist/scripts/verify-audit.js` | Referenced in README:191 but source does not exist in `scripts/` and dist only has `index.js` | Either create `scripts/verify-audit.ts` and include it in the tsup build, or remove the `node dist/scripts/verify-audit.js` example from README and rely solely on `meta_verify_audit_chain` MCP tool |

---

### Fix 5 — README accuracy (P1)

**Root cause:** PR #2 renamed `aecdm_query_element_bboxes` → `aecdm_query_element_positions` but README and `skills/SKILL.md` were not updated.

**Locations to update:**

| File | Line | Current (wrong) | Correct |
|------|------|----------------|---------|
| `README.md` | 21 | "AECDM clash detection via bounding boxes" | "AECDM element position queries (Issue pushpin support)" — mark clash detection ❌ or move to roadmap |
| `README.md` | 142 | `aecdm_query_element_bboxes` … "Three spatial modes: intersects, inside, contains" | `aecdm_query_element_positions` … "Returns element origin point from geometry transform. For true AABB, use Model Derivative API." |
| `skills/acc-forma-mcp-server/SKILL.md` | 32 | `aecdm_query_element_bboxes` | `aecdm_query_element_positions` |
| `skills/acc-forma-mcp-server/SKILL.md` | 84 | tool catalog still lists `aecdm_query_element_bboxes` | Replace with `aecdm_query_element_positions` |

---

## Sprint 3 — Production hardening (target: 2–3 days)

### Fix 6 — Durable state for approval tokens and rate counters (P1)

**Root cause:** Both `approval.ts` and `rate-governance.ts` use in-process `Map`/`Set`. Any restart (crash, deploy, scale-out) silently resets them:
- Approval tokens: pending approvals vanish; previously-issued tokens can be replayed after restart (no record)
- Rate counters: quota resets to zero, allowing burst beyond configured limits

**Short-term mitigation (document the constraint):**
Add a startup warning log: `"WARN: approval tokens and rate counters are in-memory only — single-process deployment required"`.

**Proper fix:**
- If `FORMA_AUDIT_INDEX=sqlite` is set, store `approval_tokens` and `rate_counters` in the same SQLite DB.
- Schema:
  ```sql
  CREATE TABLE approval_tokens (
    token TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL  -- unix ms
  );
  CREATE TABLE rate_counters (
    tool TEXT NOT NULL,
    project_id TEXT NOT NULL,
    hour_bucket INTEGER NOT NULL,  -- unix ms, truncated to hour
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tool, project_id, hour_bucket)
  );
  ```

---

### Fix 7 — AECDM hardening (P2)

**a) Category injection:**
`aecdm.ts:245` interpolates `category` directly into the filter string:
```ts
const filter = `property.name.category=='${category}'`;
```
A category value containing `'` (single quote) breaks the filter DSL. Validate input:
```ts
if (!/^[\w\s\-/().]+$/.test(category)) {
  throw new Error(`Invalid category name: "${category}"`);
}
```
Or escape single quotes: `category.replace(/'/g, "''")`

**b) Pagination overshoot:**
`aecdm.ts:185–187` pushes the full page before checking the limit:
```ts
all.push(...mapElements(page.results ?? []));
// ...
} while (cursor && all.length < maxElements);
```
Fix: slice before push:
```ts
const mapped = mapElements(page.results ?? []);
const remaining = maxElements - all.length;
all.push(...mapped.slice(0, remaining));
```

**c) `listAecdmCategories` parallel probe storm:**
`aecdm.ts:460` fires `Promise.all` over all ~60 COMMON_REVIT_CATEGORIES simultaneously. This can trigger APS rate limits (429) in production. Fix: use a concurrency limiter (e.g. `p-limit(8)`) and add a per-`elementGroupId` TTL cache (5 min).

---

### Fix 8 — HTTP robustness (P2)

**a) No jitter on retry backoff:**
`client.ts:50–51` doubles backoff but all concurrent retries wake at the same time. Add jitter:
```ts
const jitter = 0.5 + Math.random() * 0.5;
await sleep(waitMs * jitter);
```

**b) No token invalidation on 401:**
`client.ts` retries 401 with a fresh token fetch, but if the auth provider caches the token it will keep sending the same expired token. Call `auth.invalidateToken?.()` before the retry.

**c) GraphQL errors not normalized:**
`client.ts:91` throws `new Error(...)` for GraphQL errors. The `_wrap.ts` error handler will classify these as unexpected errors (logs ERROR, returns generic message) instead of `failed_api`. Wrap in `ApsApiError` or a dedicated `GraphQLError` subclass caught by the handler.

**d) Data Management SDK bypasses retry layer:**
`src/apis/data-management.ts:48` calls the APS SDK directly. APS SDK errors are not normalized to `ApsApiError` and have no retry/timeout guarantees from our layer. Wrap SDK calls or intercept errors and map to `ApsApiError`.

---

## Test coverage gaps

| Area | Missing tests |
|------|--------------|
| Audit chain | Tamper detection, deletion detection, genesis entry, restart chain continuity |
| Hub allow-list | Mutation denied by hub, mutation allowed when hub matches |
| MCP wrapper | `dry_run` defaults to `true`; `client_approval_only` skips two-step |
| Auth failure | APS 401 → `isError` result with helpful message |
| Retry/backoff | APS 429 with `Retry-After` header → waits correct duration |
| Audit e2e | Append → read file → verify → tamper → verify fails at correct index |

---

## Deferred (post-production)

- **`FORMA_AUDIT_FAIL_CLOSED`** env flag for audit write failure → block mutation
- **Circuit breaker** for APS endpoints (open after N consecutive 5xx)
- **`dist/scripts/verify-audit.js`** standalone CLI for ops teams
- **Approval token replay protection** across restarts (requires durable store from Fix 6)
- **3LO (Phase 3)** auth mode
