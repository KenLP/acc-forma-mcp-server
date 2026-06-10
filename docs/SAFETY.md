# Safety Guardrails

`acc-forma-mcp-server` implements layered safety controls for AI-driven access to construction data.

## Guardrail Pipeline (mutation tools only)

Every mutation tool call passes through this pipeline in order:

```
0. Auth mode check       (APS_AUTH_MODE must match tool's requiredAuthModes)
1. Allow-list check      (FORMA_ALLOWED_HUBS / FORMA_ALLOWED_PROJECTS)
2. Readonly mode check   (FORMA_READONLY / FORMA_MUTATION_MODE=readonly)
3. Rate governance       (per-tool per-project hourly limits)
4. Business rules        (local validators — no APS call)
5. Build preview         (resolve full APS request — may call APS for validation)
   └─ If dry_run=true → audit "preview" + return DryRunPreview + approval_token (stop here)
6. Approval token check  (only in preview_required mode)
7. Execute APS call
8. Audit log entry       (stage: "executed" on success, "denied_*" / "failed_api" on error)
```

Each step that fails records a `stage` = `denied_*` or `failed_api` in the audit log.

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
  "approval_token": "appr_01JXW...",
  "prev_hash": "sha256:abc...",
  "this_hash": "sha256:def..."
}
```

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
| `failed_api` | APS API call failed or approval token error |

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
- `reviews_create`: 20/project/hour
- `reviews_transition`: 50/project/hour
