# Safety Guardrails

`acc-forma-mcp-server` implements layered safety controls for AI-driven access to construction data.

## Guardrail Pipeline (mutation tools only)

Every mutation tool call passes through this pipeline in order:

```
0. Auth mode check       (APS_AUTH_MODE must match tool's requiredAuthModes)
   └─ mismatch      → audit "denied_auth_mode" + stop
1. Allow-list check      (per the tool's declared scope — see "Allow-list scoping")
   └─ refused       → audit "denied_allowlist" + stop
2. Readonly mode check   (FORMA_READONLY / FORMA_MUTATION_MODE=readonly)
   └─ refused       → audit "denied_readonly" + stop
3. Rate governance       (per-tool per-project hourly limits)
   └─ over limit    → audit "denied_rate_limit" + stop
4. Business rules        (local validators — no APS call)
   └─ violated      → audit "denied_business_rule" + stop
5. Build preview         (resolve full APS request — may call APS for validation)
   └─ dry_run=true  → audit "preview" + return DryRunPreview + approval_token (stop here)
6. Idempotency check     (only when idempotency_key is supplied)
   └─ cache hit     → audit "idempotent_replay" + return the prior result (no APS call)
   └─ key reused for another operation → audit "denied_idempotency" + stop
7. Approval token check  (only in preview_required mode)
   └─ no token      → audit "denied_missing_approval" + stop
   └─ bad token     → audit "denied_approval" + stop
8. Execute APS call
9. Audit log entry       ("executed"; "failed_api" if APS returned an error;
                          "outcome_unknown" if the request got no response at all)
```

Every branch above records an entry — no path through the wrapper returns without one. That is
what lets the log answer "what did the agent actually do", including the times it was stopped.

One boundary to know: the wrapper is only reached once the MCP SDK has validated the call
against the tool's input schema. A request with malformed input, or naming a tool that does not
exist, is refused by the protocol layer and never reaches step 0 — so it produces no audit
entry. Nothing is lost by that: such a call touches no Autodesk API and performs no action.
The claim the manifest makes is therefore "every invocation that reaches a handler", not
"every byte that arrived on stdin".

## Audit Log

### Format

Daily JSONL files at `FORMA_AUDIT_DIR/audit-YYYY-MM-DD.jsonl`. One JSON object per line:

```json
{
  "ts": "2026-04-16T10:23:45.123Z",
  "id": "evt_01JXWABCDE...",
  "tool": "issues_create",
  "kind": "mutation",
  "stage": "executed",
  "actor": { "auth_mode": "ssa", "ssa_id": "...", "user_email": null },
  "project_id": "b.abc-123",
  "input_redacted": { "title": "Leak at Level 3", "issue_subtype_id": "..." },
  "output_summary": { "created_id": "issue-uuid", "http_status": 201 },
  "approval_token": "9f2a1c4e7b3d5a80",
  "prev_hash": "sha256:abc...",
  "this_hash": "sha256:def..."
}
```

The live approval token is never written to the audit log. On the `executed` stage, the
`approval_token` field above holds only a 16-character SHA-256 **fingerprint**
(`fingerprintToken()` in `src/safety/approval.ts`, applied in `src/tools/_wrap.ts` before the
entry is written) — never the live token. The `preview` stage records the same fingerprint
under `output_summary.approval_token_fp`, so the two entries can be linked without either one
exposing a usable token. The JSONL is readable on disk and a live token stays valid for its
whole TTL, so writing it would let anyone who can read the log replay the mutation.

### Tamper detection

`this_hash = sha256(prev_hash + canonical_json(all_other_fields))`. Modifying any entry invalidates all subsequent hashes. Verify with:

```bash
# Via MCP tool (recommended)
meta_verify_audit_chain()

# Or inspect the JSONL directly
cat ~/.acc-forma-mcp/audit/audit-$(date +%F).jsonl | jq .
```

**What this does and does not prove.** `verifyChain` walks the entries it is given and checks
two things: each entry's `this_hash` matches its content, and `prev_hash` matches the prior
entry's `this_hash` (index 0 must equal genesis). A valid result means no entry *within that
file* was silently modified, reordered, or inserted — that is real tamper detection.

It is not a completeness proof. Two attacks it cannot see, both confirmed by probing a real
audit file: (1) **truncating the file** — deleting the last N lines and leaving the rest
intact still verifies as valid, because there is nothing after the cut to disagree with it;
(2) **replacing the whole file** with a brand-new chain that starts its own `prev_hash` at
`sha256:genesis` — verified independently, a self-consistent second chain looks exactly like a
valid first one. Both require access to the audit file on disk, which is a smaller blast
radius than "the log lies about history to a caller who never touches the filesystem," but the
verifier alone does not rule them out.

Closing that gap needs a trust anchor the log cannot forge on its own — e.g. periodically
pushing a signed checkpoint (the current `this_hash` plus entry count, signed with a key that
never touches the same disk as the log) to storage the operator does not also control. That is
**not implemented** — it is backlog for a future round (tracked as R4), a deliberate scope cut
for now rather than an oversight. Until it exists, treat `meta_verify_audit_chain` as proof the
retained log is internally consistent, not as proof nothing was ever cut from it.

### Stage values

| Stage | Meaning |
|---|---|
| `preview` | dry_run=true returned — no APS write occurred |
| `executed` | Write executed successfully |
| `denied_readonly` | Blocked by FORMA_READONLY or FORMA_MUTATION_MODE=readonly |
| `denied_allowlist` | Project/hub not in allow-list |
| `denied_rate_limit` | Local per-tool hourly quota exceeded |
| `denied_business_rule` | Tool-specific validation failed (e.g. invalid subtype ID, past due_date) |
| `failed_api` | APS API call failed |
| `outcome_unknown` | A mutation request did not complete cleanly — see below |
| `denied_auth_mode` | Tool requires an auth mode the server is not currently running in |
| `denied_missing_approval` | dry_run=false called with no approval_token, in preview_required mode |
| `denied_approval` | approval_token was present but invalid, expired, already consumed, or bound to a different payload |
| `denied_idempotency` | idempotency_key reused for a different operation (different tool or payload) |
| `idempotent_replay` | A cached result was returned for a repeated idempotency_key; the APS call did NOT re-execute |

`outcome_unknown` — a mutation request did not complete cleanly: either no response arrived
(timeout/socket error) or Autodesk answered 5xx, which it may have done after applying the
change. Distinct from `failed_api`, which means the call definitively did not take effect.
Treat these entries as "verify before retrying".

## Remote mode isolation

`FORMA_TRANSPORT=http` (the hosted service, and any self-hosted multi-tenant deployment)
isolates customers differently than the allow-list does in local stdio mode:

- **`FORMA_ALLOWED_HUBS` / `FORMA_ALLOWED_PROJECTS` stay `*` in remote mode.** Tenant
  isolation is enforced by the tenant's own robot membership at the Autodesk API layer — each
  tenant is a dedicated Secure Service Account, and it can only ever see the hubs/projects
  its own hub admin has added it to. A project-scoping allow-list on top of that would not
  add isolation between tenants (each robot already can't see another tenant's data); it
  would only additionally break tools this server cannot bind to a Data Management id in the
  first place.
- **Consequence for `unmappable`-scope tools:** in local stdio mode, narrowing
  `FORMA_ALLOWED_HUBS`/`FORMA_ALLOWED_PROJECTS` refuses every tool declared
  `scope: {kind:'unmappable'}` (all `aecdm_*`, `md_*`, `docs_get_viewables`,
  `issues_pin_element`, all `webhooks_*` — see "Allow-list scoping" in `CLAUDE.md`), because
  their ids can't be checked against a narrowed list. In remote mode the allow-list is never
  narrowed, so this refusal never triggers for `aecdm_*`, `md_*`, `docs_get_viewables`, and
  `issues_pin_element` — those tools work normally, bounded only by what the tenant's robot is
  actually a member of. The 3 `webhooks_*` tools are a separate case: they are never
  *registered* at all under remote transport (`remoteEnabled: false` — they require 2-legged
  auth, which `buildTenantContext` deliberately never attaches per-tenant; see
  "Allow-list scoping" in `CLAUDE.md` and `src/server.ts`), so the allow-list question does
  not even arise for them in remote mode.
- **What this does *not* change:** every other guardrail in the pipeline above (readonly
  mode, rate governance, business rules, dry-run/approval, audit) applies identically in
  remote mode, per tenant — see `src/tenancy/context.ts` (`buildTenantContext`) for how each
  request gets its own `env`/`auth` scoped to one tenant before it ever reaches this
  pipeline.

## Offboarding a tenant

`disableTenant()` (`src/tenancy/robot-store.ts`) does exactly one thing: `UPDATE tenants SET
disabled = 1 WHERE id = ?`. It does **not** evict anything from `tenantProviderCache`, the
module-level `Map<string, SsaAuthProvider>` in `src/tenancy/context.ts` that holds each
tenant's decrypted robot private key and cached access token for the lifetime of the server
process. That is not an auth hole — `findTenantByBearerKey()` filters `WHERE disabled = 0`
*before* a request ever reaches the cache, so a disabled tenant's bearer key is rejected at
the lookup and the cached provider is never consulted. What it does leave open is narrower:
(a) a request already past that lookup when `disable` runs completes normally — there is no
mid-flight cancellation, and (b) the tenant's decrypted key material stays resident in the
server's RAM until the process restarts.

The CLI that runs `disable` (`tenant-admin.ts`) executes over `fly ssh console` — a
**separate OS process** from the one serving `/mcp` requests. It has no way to reach into the
live server process and clear its in-memory `Map`; only restarting that process does. This is
why offboarding is a documented sequence rather than a single command:

1. **`node dist/tenant-admin.js disable <tenantId>`** (via `fly ssh console -C "..." --app
   bimlynx-mcp`, per the CLI note under "R2a" in `docs/HANDOFF.md`). New requests with this
   tenant's bearer key are rejected immediately — the check happens locally, before any
   Autodesk call.
2. **Requests already in flight finish anyway.** There is no cancellation path once a call
   has passed the disabled check; if that matters for a specific offboarding (e.g. a
   compliance request with a hard cutoff time), wait out the longest tool timeout after step
   1 before treating access as fully closed.
3. **`fly machines restart --app bimlynx-mcp`** to flush `tenantProviderCache`. This clears
   the decrypted private key and any cached APS access token for every tenant from RAM, not
   just the one being offboarded — restart is process-wide, there is no per-tenant evict. The
   CLI cannot do this step itself (see above); it must be run separately, and only matters if
   the decrypted key sitting in RAM until next restart is a real concern for the request at
   hand.
4. **Permanent deletion, if the customer asks for it.** There is currently no CLI command for
   this — `robot-store.ts` only exports `disableTenant()`, not a delete — so it is a manual
   SQLite operation against `/data/state.db` on the volume (via `fly ssh console`, e.g. with a
   short inline `node -e` script using `better-sqlite3`, since the image has no `sqlite3`
   binary). Rows to remove, by table (see `src/persistence/db.ts` for the schema):
   - `tenants` — `DELETE FROM tenants WHERE id = ?` (the tenant record itself: robot email,
     service account id, key id, encrypted private key, bearer key hash).
   - `approval_tokens`, `rate_counters`, `idempotency_records` — each keyed by a composite
     `PRIMARY KEY (tenant_id, ...)`; `DELETE FROM <table> WHERE tenant_id = ?` on each. In
     practice these usually expire on their own (TTL / hourly bucket) well before a deletion
     request is actioned, but a request for "delete everything now" should not wait on that.
   - Audit log — delete the tenant's whole subdirectory, `<FORMA_AUDIT_DIR>/<tenantId>/`
     (`FORMA_AUDIT_DIR` defaults to `/data/audit` in the deployed container; see
     `buildTenantContext` in `src/tenancy/context.ts` for how that path is derived from
     `tenant.id`).

   This path is manual and currently untested against the deployed volume — treat it as an
   operator procedure to follow carefully on a live database, not a verified script. Do this
   *after* step 3 (restart), not before: deleting the `tenants` row while the provider is
   still cached does not itself invalidate anything already in memory.
5. **Autodesk-layer removal (customer's own action, independent of all of the above).** The
   customer's hub admin removes the robot from Hub Admin → Custom Integrations, or removes its
   project/hub membership. This cuts access at the API layer regardless of what state this
   server's database or process memory are in, and does not depend on the publisher having
   completed any step above — see `PRIVACY.md` §4, which lists this as the fastest,
   publisher-independent option.

## Rate Governance Config

Override default limits by setting `FORMA_RATE_CONFIG_PATH` to a JSON file:

```json
{
  "issues_create":    { "per_project_per_hour": 20 },
  "reviews_create":   { "per_project_per_hour": 10 }
}
```

Default limits (built-in):
- `issues_create`: 50/project/hour
- `issues_update`: 100/project/hour
- `issues_add_comment`: 100/project/hour
- `issues_pin_element`: 50/project/hour
- `reviews_create`: 20/project/hour
- `reviews_transition`: 50/project/hour

`md_trigger_translation` is deliberately absent: it takes a URN, not a project id, so there is
no project to bucket a rate counter on.

Source of truth: `DEFAULT_RATE_CONFIG` in `src/safety/rate-governance.ts`.

## Known Limitations / Production Notes

These are current constraints to understand before deploying in a production environment.

### Approval tokens, rate counters, and idempotency keys

By default (`FORMA_PERSISTENCE_MODE=memory`) these are stored in process memory only. On server restart, all pending tokens are lost — callers whose dry-run completed but whose execute call arrives after a restart must repeat the dry-run. Rate counters reset, and deduplicated idempotency keys are forgotten.

Set `FORMA_PERSISTENCE_MODE=sqlite` to use a local SQLite database (path configured via `FORMA_DB_PATH`, default `~/.acc-forma-mcp/state.db`). This makes tokens, counters, and idempotency records durable across restarts. Note: SQLite is still single-process only — horizontal scaling requires externalizing those stores to a shared backend (Redis, PostgreSQL, etc.).

### Audit log: fail-open default

By default (`FORMA_AUDIT_FAIL_CLOSED=false`), if the audit JSONL file cannot be written (disk full, permission denied, etc.), the server **logs the error but continues** — the mutation result is returned normally without an audit record.

Set `FORMA_AUDIT_FAIL_CLOSED=true` to surface audit write failures as errors. **Important caveat:** the audit write happens *after* the APS call, so if the write fails post-execution the APS change has already been applied. The error response distinguishes the two cases:
- Audit failed *before* execution → "NOT executed — safe to retry"
- Audit failed *after* execution → "HAS been applied — do NOT retry"

### Audit hash chain: restart breaks the chain

The `lastHash` pointer used for SHA-256 chain continuity is in-memory. On restart, `loadLastHashFromFile()` reads the last entry from today's audit file to restore the hash, but any failure in that read (missing file, malformed JSON, permission error) resets the chain to `sha256:genesis` and logs a WARN. A chain verification that spans a restart may show a break at that point.

### DM SDK: same retry behavior as the rest

The Data Management adapter (`src/apis/data-management.ts`) wraps APS SDK calls in
`callSdk()`, which applies the same exponential-backoff retry (with jitter) and
401 token-invalidation as `apsRequest()` in `src/http/client.ts`. Errors that
exhaust retries surface as `ApsApiError`.

### No circuit breaker

There is no circuit breaker for APS endpoints. Consecutive 5xx responses will continue to be retried with backoff (for endpoints using `apsRequest`) or surfaced immediately (DM SDK). A circuit breaker is not yet implemented.

### Single-process deployment only

Even with `FORMA_PERSISTENCE_MODE=sqlite`, this server must run as a single process — SQLite does not support concurrent writers from multiple processes. Horizontal scaling requires externalizing approval tokens, rate counters, and idempotency records to a shared backend (Redis, PostgreSQL, etc.).
