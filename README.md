# acc-forma-mcp-server

> Production-ready, safety-first MCP server for **Autodesk Forma** (formerly Autodesk Construction Cloud).
> Every write is dry-runnable, audit-logged, and scope-guarded.

**Read everything · Preview every write · Audit every action.**

[![CI](https://github.com/KenLP/acc-forma-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/KenLP/acc-forma-mcp-server/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

---

## Why this server?

| Capability | Other ACC/APS MCP servers | acc-forma-mcp-server |
|---|---|---|
| Issues read + write | Partial | ✅ |
| Reviews read + write | Partial | ✅ |
| AEC Data Model (BIM element queries) | Separate .NET server only | ✅ |
| **AECDM clash detection via bounding boxes** | ❌ | ✅ |
| **Dry-run preview before any write** | ❌ | ✅ |
| **Tamper-evident audit log (JSONL + hash chain)** | ❌ | ✅ |
| **Project/hub allow-list enforcement** | ❌ | ✅ |
| **Read-only mode toggle** (`FORMA_READONLY=true`) | ❌ | ✅ |
| **Per-tool hourly rate governance** | ❌ | ✅ |
| **Business-rule validators** | ❌ | ✅ |
| TypeScript strict mode | Partial | ✅ |

---

## Quickstart

### Option 1 — npx (zero install, after publish)

```bash
npx acc-forma-mcp-server
```

### Option 2 — Clone & run locally

```bash
git clone https://github.com/KenLP/acc-forma-mcp-server.git
cd acc-forma-mcp-server
pnpm install
pnpm build
node dist/index.js
```

### Option 3 — Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forma": {
      "command": "node",
      "args": ["/absolute/path/to/acc-forma-mcp-server/dist/index.js"],
      "env": {
        "APS_CLIENT_ID": "your_client_id",
        "APS_CLIENT_SECRET": "your_client_secret",
        "APS_AUTH_MODE": "ssa",
        "SSA_ID": "your_ssa_id",
        "SSA_KEY_ID": "your_key_id",
        "SSA_KEY_PATH": "/absolute/path/to/private-key.pem"
      }
    }
  }
}
```

---

## Prerequisites

1. **Autodesk Platform Services account** — [aps.autodesk.com](https://aps.autodesk.com)
2. **APS Application** with "Autodesk Construction Cloud" product APIs enabled
3. **Secure Service Account (SSA)** — see [docs/AUTH.md](docs/AUTH.md) for setup
4. SSA email invited to the target Forma hub(s) with appropriate role
5. APS app provisioned on the hub via **Hub Admin → Custom Integrations**

---

## Available Tools — Phase 1 MVP

## Tools (30)

All tools are grouped by domain. Read tools take no approval; write/mutation tools (marked ✍️) follow the [two-call dry-run protocol](#safety).

### Account Admin (4)

| Tool | Purpose |
|---|---|
| `admin_list_projects` | List all projects under a hub (hub-wide visibility via 2LO). |
| `admin_get_project` | Fetch a single project's metadata, scopes, and relationships. |
| `admin_list_users` | List users in the account / project membership. |
| `admin_list_companies` | List companies registered on the account. |

### Data Management (6)

| Tool | Purpose |
|---|---|
| `dm_list_hubs` | List ACC/BIM 360 hubs accessible to the app. |
| `dm_list_projects` | List projects in a hub. |
| `dm_list_top_folders` | List the top-level folders of a project (Plans, Project Files, etc.). |
| `dm_list_folder_contents` | List items (files + subfolders) in a folder. |
| `dm_get_item` | Get metadata for a single item (file or folder). |
| `dm_list_versions` | List all versions of a file with version numbers and timestamps. |

### Issues (6)

| Tool | Purpose |
|---|---|
| `issues_list` | List issues in a project with filters (status, type, assignee). |
| `issues_get` | Get a single issue including comments and attachments metadata. |
| `issues_create` ✍️ | Create a new issue with subtype, location, due date, assignment. |
| `issues_add_comment` ✍️ | Add a comment to an existing issue. |
| `issues_list_types` | List valid issue types and subtypes (with `isActive` flag) for a project. |
| `issues_list_root_causes` | List configured root cause categories for a project. |

### Reviews (4)

| Tool | Purpose |
|---|---|
| `reviews_list` | List reviews in a project's Reviews container. |
| `reviews_get` | Get a single review including status and reviewers. |
| `reviews_create` ✍️ | Create a new review with reviewers, due date, workflow, linked documents. |
| `reviews_transition` ✍️ | Submit / approve / reject / void / reopen a review. |

### AEC Data Model — BIM GraphQL (8)

| Tool | Purpose |
|---|---|
| `aecdm_list_hubs` | List AECDM-native hubs (distinct from DM hubs). Start here for any AECDM workflow. |
| `aecdm_list_projects` | List projects in an AECDM hub. |
| `aecdm_list_element_groups` | List BIM model files (Revit/IFC) published to an AECDM project, including `fileVersionUrn`. |
| `aecdm_list_categories` | List BIM categories present in an element group (Walls, Structural Columns, MEP equipment, etc.) by parallel-probing ~60 well-known Revit categories. |
| `aecdm_query_elements` | Query BIM elements by category with full properties. Supports multi-word categories like `Structural Columns`, `Electrical Equipment`. |
| `aecdm_get_element_properties` | Re-fetch full properties for a specific element by node ID (requires the originating category). |
| `aecdm_aggregate_by_parameter` | Count elements grouped by a parameter value within a category (e.g. walls by type name) — fast take-off queries. |
| `aecdm_query_element_bboxes` | Query elements with axis-aligned bounding boxes. Three spatial modes: `intersects` (clash detection), `inside` (containment), `contains` (envelope). Uses the AECDM `geometry` beta field. |

### Meta / Observability (2)

| Tool | Purpose |
|---|---|
| `meta_list_changelog` | Read the local audit log entries with filters by tool, time, or project. |
| `meta_verify_audit_chain` | Verify the audit log hash chain has not been tampered with. |


More tools in Phase 2 (RFIs, Submittals, Forms, Sheets, Files, Photos, Locations, Assets, Webhooks).

---

## Safety Guardrails

### 1. Dry-run by default

Every mutation tool defaults to `dry_run=true`. On first call, the server:
- Validates allow-lists, read-only mode, rate limits, business rules
- Resolves the exact APS API request (method, URL, body)
- Returns a **preview** + single-use `approval_token`
- Does **not** call APS

To execute, re-call the same tool with `dry_run=false, approval_token=<token>`.

```
Claude: "Create an issue titled 'Leak at Level 3' in project xyz"

Tool: issues.create(dry_run=true)
→ {
    preview: { method: "POST", url: "...issues", body: {...} },
    approval_token: "appr_01JXW...",
    next_step: "Re-call with dry_run=false and approval_token to execute"
  }

Tool: issues.create(dry_run=false, approval_token="appr_01JXW...")
→ Issue created: ID abc-456
```

### 2. Tamper-evident audit log

All tool calls are appended to `~/.acc-forma-mcp/audit/audit-YYYY-MM-DD.jsonl` with SHA-256 hash chaining. Verify integrity at any time:

```bash
# Using the MCP tool
meta.verify_audit_chain()

# Or manually
node dist/scripts/verify-audit.js ~/.acc-forma-mcp/audit/audit-2026-04-16.jsonl
```

### 3. Project allow-list

```env
FORMA_ALLOWED_PROJECTS=proj-uuid-1,proj-uuid-2
FORMA_ALLOWED_HUBS=hub-id-1
```

The server rejects any tool call referencing a project/hub outside this list — independent of SSA permissions.

### 4. Read-only mode

```env
FORMA_READONLY=true
# or
FORMA_MUTATION_MODE=readonly
```

Blocks all mutation tools instantly, without touching APS.

### 5. Mutation modes

| `FORMA_MUTATION_MODE` | Behavior |
|---|---|
| `preview_required` (default) | Must dry_run=true first; re-call with approval_token |
| `client_approval_only` | Single call; trust MCP client's built-in approval UI |
| `readonly` | All mutations blocked |

---

## Configuration

Copy `.env.example` to `.env` and fill in your values. All options documented with comments in `.env.example`.

Key variables:

| Variable | Default | Description |
|---|---|---|
| `APS_CLIENT_ID` | — | Required |
| `APS_CLIENT_SECRET` | — | Required |
| `APS_AUTH_MODE` | `ssa` | `ssa`, `2lo`, or `3lo` (3lo: Phase 3) |
| `SSA_ID` | — | Required for SSA mode |
| `SSA_KEY_ID` | — | Required for SSA mode |
| `SSA_KEY_PATH` | — | Path to PEM private key file |
| `FORMA_READONLY` | `false` | Block all mutations |
| `FORMA_MUTATION_MODE` | `preview_required` | See Safety section |
| `FORMA_ALLOWED_HUBS` | `*` | Comma-separated hub IDs |
| `FORMA_ALLOWED_PROJECTS` | `*` | Comma-separated project UUIDs |
| `FORMA_AUDIT_DIR` | `~/.acc-forma-mcp/audit` | JSONL audit log directory |

---

## Development

```bash
# Install
pnpm install

# Build
pnpm run build

# Type check
pnpm run typecheck

# Tests
pnpm run test

# Watch mode
pnpm run test:watch
```

---

## Skill (for Claude Desktop / Claude Code)

A companion Anthropic-format skill is provided at `./skills/acc-forma-mcp-server/SKILL.md` documenting workflows, the dual-auth matrix, AECDM filter syntax, and debugged gotchas. Load it alongside the MCP server for better tool selection and fewer dead-end paths.

---

## License

MIT — see [LICENSE](LICENSE).

**Not affiliated with Autodesk, Inc.** Autodesk Forma®, Autodesk Construction Cloud®, and Autodesk Platform Services® are trademarks of Autodesk, Inc.
