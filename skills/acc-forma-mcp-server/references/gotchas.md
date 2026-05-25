# Gotchas — collected failure modes and fixes

These are the exact issues encountered during production debugging of acc-forma-mcp-server. Each entry includes the symptom, root cause, and the verified fix. When a user reports one of these, recognise it and apply the fix instead of guessing.

## AECDM

### "Element not found" from `aecdm_get_element_properties`

**Symptom:** User passes a real element ID from `aecdm_query_elements` and the tool returns "not found".

**Root cause:** The AECDM filter DSL operates on element properties, not on the GraphQL node ID. Element IDs (`YWVjZX5t...`) are base64-encoded node IDs and cannot be used as filter values via `property.name.id==<id>`.

**Fix:** Pass the same `category` parameter that produced the element ID. The server queries the category, then matches the node ID client-side.

```
aecdm_query_elements(category="Structural Columns")  → element_id YWVjZX5t...
aecdm_get_element_properties(element_id, category="Structural Columns")
```

In most cases users don't need this tool at all — `aecdm_query_elements` already returns full properties.

### `aecdm_list_categories` returns empty for an obviously-rich model

**Symptom:** A Revit model clearly contains Walls, Structural Columns, etc., but the tool reports "No element categories found".

**Root cause:** The model file was uploaded **before** AEC Data Model was enabled on the hub. AECDM does not retroactively index pre-existing files.

**Fix (user action, not code):**
1. Open the Revit file.
2. Re-publish to ACC (creates a new version).
3. Re-run `aecdm_list_element_groups` and use the newest element_group_id.

Do not claim the tool is broken — it has been verified to work on freshly-published models.

### Multi-word category filters return empty (Structural Columns, Electrical Equipment, ...)

**Symptom:** `aecdm_query_elements` works for "Walls" but returns nothing for "Structural Columns".

**Root cause:** The filter DSL requires single quotes around the value. Without quotes, multi-word values are parsed as separate tokens.

**Fix (already applied in current code):** Filter is built as `property.name.category=='${category}'`. If you find code that builds `property.name.category==${category}` (no quotes), update it.

### DM hub ID passed to AECDM tools

**Symptom:** `aecdm_list_projects(hub_id=<DM hub ID>)` returns empty or 404.

**Root cause:** AECDM has its own hub ID namespace, distinct from DM.

**Fix:** Always start AECDM workflows with `aecdm_list_hubs`. Never reuse `dm_list_hubs` IDs.

## Issues

### `issues_create` returns 401 in 2LO mode

**Symptom:** Hub-wide read tools work, but creating an issue returns 401.

**Root cause:** Issues API requires SSA (or 3LO) — 2LO is not accepted.

**Fix:** Restart the server with `APS_AUTH_MODE=ssa` and the SSA env vars (`SSA_ID`, `SSA_KEY_ID`, `SSA_KEY_PATH`).

### `issues_create` rejected for missing `issue_subtype_id`

**Symptom:** Server returns a business-rule error: "issue_subtype_id_must_exist".

**Root cause:** The API requires `issueSubtypeId`, not `issueTypeId`. Each project has a unique set of subtype IDs.

**Fix:** Call `issues_list_types` first to get valid subtype IDs for the project. Pass one of those.

### Forgot `assigned_to_type` when `assigned_to` is set

**Symptom:** Server rejects with "assigned_to_type_required".

**Root cause:** ACC issues API requires both fields together.

**Fix:** Pass `assigned_to_type` as one of `'user' | 'company' | 'role'`.

### `due_date` rejected as in the past

**Symptom:** Server-side business rule blocks the create.

**Root cause:** The server enforces "due date must be today or in the future" before issuing the approval token.

**Fix:** Use a current or future date in `YYYY-MM-DD` format.

## Reviews

### `reviews_create` returns 404

**Symptom:** Calls fail with 404 even with valid project_id.

**Root cause:** The Reviews container ID must be resolved from the project's relationships. The server does this automatically when given `hub_id`, but if hub_id is missing or wrong, container resolution fails.

**Fix:** Pass `hub_id` from `dm_list_hubs`. The server resolves Reviews container ID via `getProject().relationships.reviews.data.id`. If the project doesn't expose a `reviews` relationship, the Reviews module is not activated for that project — activate it in ACC admin.

## Mutations (Issues / Reviews)

### Calling with `dry_run=false` without `approval_token`

**Symptom:** Server rejects with "approval_token required".

**Root cause:** Two-call approval pattern is mandatory.

**Fix:**
1. First call: `dry_run=true` (default). Show the preview to the user.
2. Second call: `dry_run=false` AND `approval_token=<token from step 1>`.

### Replaying an approval token with different inputs

**Symptom:** Server rejects with "token does not match payload".

**Root cause:** The token is a hash of the execute payload. Changing any input invalidates the token.

**Fix:** Re-run step 1 with the corrected inputs to get a fresh token.

## Tool naming

### Claude.ai chat rejects tool names with dots

**Symptom:** `tools.X.FrontendRemoteMcpToolDefinition.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`.

**Root cause:** MCP spec requires tool names to match that regex. Dots are invalid.

**Fix (already applied):** All tool names use underscores: `dm_list_hubs`, not `dm.list_hubs`.

## Logger / transport

### MCP server fails to start with "parse error"

**Symptom:** Claude Desktop shows "Server disconnected" with a JSON parse error in logs.

**Root cause:** Pino logger writing to stdout corrupts the MCP stdio transport (which expects only JSON-RPC frames on stdout).

**Fix (already applied):** Logger is configured with `pino.destination(2)` to write to stderr.

## Environment

### `APS_AUTH_MODE=two-legged` rejected

**Symptom:** Server fails to start with a Zod validation error.

**Root cause:** The valid values are `'2lo'`, `'ssa'`, `'3lo'`. Not the long-form names.

**Fix:** Use `APS_AUTH_MODE=2lo` or `APS_AUTH_MODE=ssa`.

## Diagnosis flowchart

When a user reports an issue:

1. **Empty AECDM data?** → Suspect indexing (re-publish), not code.
2. **401/403?** → Check auth mode matches the tool's requirements.
3. **404 on Reviews?** → Verify Reviews module is activated for the project.
4. **"Element not found" on get_element_properties?** → Missing `category` argument.
5. **Multi-word category filter fails?** → Verify filter is built with single quotes around the value.
6. **Mutation rejected?** → Check the two-call protocol was followed end-to-end.
