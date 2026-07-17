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

Every branch above records an entry — there is no path that returns without one. That is what
lets the log answer "what did the agent actually do", including the times it was stopped.

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
