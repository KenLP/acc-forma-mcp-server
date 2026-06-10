---
name: aps-acc-forma-mcp
description: >
  Use the acc-forma-mcp-server tools to interact with Autodesk Construction
  Cloud (ACC) and Forma. Apply this skill whenever the user asks to list hubs
  or projects, browse documents, create or query issues, manage reviews, query
  BIM elements (Walls, Structural Columns, etc.) via the AEC Data Model API,
  or audit changelog and approvals. Covers the correct call ordering, the
  dual-auth model (2LO vs SSA), AECDM filter-DSL gotchas, and the two-call
  approval pattern for mutations.
metadata:
  author: acc-forma-mcp-server contributors
  version: "0.1"
compatibility: Requires the acc-forma-mcp-server MCP server (Node.js 20+) registered with the host (Claude Desktop, Claude Code, etc.). The server must be authenticated in either 2LO or SSA mode.
---

# Working with acc-forma-mcp-server

This server exposes 30 tools across six domains of Autodesk Construction Cloud (ACC) and Forma. The tool surface is stable but the underlying APS APIs have several non-obvious behaviours — apply the rules below to avoid the most common failure modes.

## Step 1 — Identify the user's domain

| User intent | Domain | Entry tool |
|---|---|---|
| "List my hubs / projects" | Data Management | `dm_list_hubs` → `dm_list_projects` |
| "Find a model file / version" | Data Management | `dm_list_top_folders` → `dm_list_folder_contents` → `dm_list_versions` |
| "Account admin (users, companies)" | Account Admin | `admin_list_projects`, `admin_list_users`, `admin_list_companies` |
| "Issues — list / get / comment" | Issues | `issues_list`, `issues_get`, `issues_add_comment` |
| "Create an issue" | Issues (mutation) | `issues_list_types` → `issues_create` (2-call pattern, see Step 4) |
| "Review submittals / approvals" | Reviews | `reviews_list`, `reviews_get`, `reviews_create`, `reviews_transition` |
| "Query BIM elements / categories" | AEC Data Model | `aecdm_list_hubs` → … → `aecdm_query_elements` (see `references/workflow-aecdm.md`) |
| "Element positions / Issue pushpins" | AEC Data Model | `aecdm_query_element_positions` (returns origin point per element; filter by reference bbox) |
| "Audit changelog / verify chain" | Meta | `meta_list_changelog`, `meta_verify_audit_chain` |

Always begin with the entry tool — never invent IDs. If the user already gave a hub_id, project_id, or element_group_id, validate it by calling the matching list tool first when the result looks suspicious.

## Step 2 — AEC Data Model: read the workflow doc first

The AECDM domain is the trickiest — it has its own hub/project IDs (different from DM hub IDs), filter DSL quirks for multi-word category names, and indexing prerequisites. Before issuing any AECDM call, load `references/workflow-aecdm.md`.

Key facts to internalise:

- **AECDM hubs ≠ DM hubs.** Always start with `aecdm_list_hubs`, never reuse `dm_list_hubs` IDs.
- **Files uploaded BEFORE the hub had AEC Data Model enabled are not indexed.** Empty results for `list_categories` / `query_elements` usually mean re-publish is needed, not a code bug.
- **Filter DSL requires single quotes around values**, even single-word ones:
  `property.name.category=='Walls'` — not `==Walls`.
- **GraphQL node IDs are not properties.** `aecdm_get_element_properties` cannot filter by node id directly; it requires `category` to scope the query first.

## Step 3 — Authentication modes (2LO vs SSA)

The server runs in one of two auth modes, and tools are gated to the modes they support. Read `references/auth-modes.md` for the full matrix. Quick rules:

- **2LO (`client_credentials`)** — used by Data Management and Admin tools. Sees all hub-wide projects.
- **SSA (Secure Service Account)** — used by Issues, Reviews, AECDM. Project-scoped — only sees projects the SSA is provisioned for.
- The server auto-switches per tool using the `preferredAuth` annotation; you don't need to do anything, but if a tool returns 401/403 it usually means the SSA is not provisioned on that project.

## Step 4 — Two-call approval pattern for mutations

`issues_create`, `reviews_create`, `reviews_transition` are **mutations** and follow a strict two-call protocol:

1. **First call**: `dry_run=true` (default). Returns a preview + `approval_token`. Show the preview to the user verbatim.
2. **Second call**: `dry_run=false` and `approval_token=<token>` from step 1. Executes for real.

Never skip step 1, never invent a token, never call `dry_run=false` on the user's behalf without explicit confirmation. The server enforces this with a server-side hash of the execute payload — replaying step 1 with different inputs will invalidate the token.

## Step 5 — Common pitfalls

Before answering, double-check `references/gotchas.md` if any of these apply:

- User reports "Element not found" for `aecdm_get_element_properties` → missing `category` parameter (most common).
- User reports `aecdm_list_categories` returns empty → re-publish prompt; do NOT claim the tool is broken.
- User reports issue creation 401 in 2LO mode → tool is SSA-only; restart server with `APS_AUTH_MODE=ssa` and SSA credentials.
- User passes a DM hub ID to an `aecdm_*` tool → call `aecdm_list_hubs` first.
- User asks for "all elements in the model" → AECDM requires a filter argument; query per category instead.

## Tool catalog (29)

| Domain | Tools |
|---|---|
| Data Management (6) | `dm_list_hubs`, `dm_list_projects`, `dm_list_top_folders`, `dm_list_folder_contents`, `dm_get_item`, `dm_list_versions` |
| Account Admin (4) | `admin_list_projects`, `admin_get_project`, `admin_list_users`, `admin_list_companies` |
| Issues (6) | `issues_list`, `issues_get`, `issues_create`, `issues_add_comment`, `issues_list_types`, `issues_list_root_causes` |
| Reviews (4) | `reviews_list`, `reviews_get`, `reviews_create`, `reviews_transition` |
| AEC Data Model (8) | `aecdm_list_hubs`, `aecdm_list_projects`, `aecdm_list_element_groups`, `aecdm_list_categories`, `aecdm_query_elements`, `aecdm_get_element_properties`, `aecdm_aggregate_by_parameter`, `aecdm_query_element_positions` |
| Meta (2) | `meta_list_changelog`, `meta_verify_audit_chain` |

## References

- `references/workflow-aecdm.md` — full AECDM call ordering, filter DSL, structural categories, schema gotchas
- `references/auth-modes.md` — when 2LO is used vs SSA; provisioning checklist
- `references/gotchas.md` — collected failure modes and their fixes from production debugging

## Key rules

1. **Never invent IDs.** Always derive IDs from the matching list tool.
2. **Always start AECDM workflows with `aecdm_list_hubs`** — DM hub IDs do not work.
3. **Always quote filter values**: `property.name.category=='X'`, not `==X`.
4. **Two-call mutations are non-negotiable** — show the preview, get explicit approval, then execute with the token.
5. **Read tools' descriptions verbatim** before reformulating — they encode the latest behaviour.
6. **When AECDM returns empty, suspect indexing first**, not the code. The tool surface has been verified end-to-end.
