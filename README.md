# acc-forma-mcp-server

> Safety-first MCP server for **Autodesk Forma** (formerly Autodesk Construction Cloud).
> Every write is dry-runnable, audit-logged, and scope-guarded.

**Read everything · Preview every write · Audit every action.**

[![CI](https://github.com/KenLP/acc-forma-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/KenLP/acc-forma-mcp-server/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

---

## Why this server?

| Capability | Other ACC/APS MCP servers | acc-forma-mcp-server |
|---|---|---|
| Issues read + write (full CRUD + comments + attachments) | Partial | ✅ |
| Reviews read + write | Partial | ✅ |
| AEC Data Model (BIM element queries) | Separate .NET server only | ✅ |
| **AECDM element position queries (Issue pushpin support)** | ❌ | ✅ |
| **Dry-run preview before any write** | ❌ | ✅ |
| **Tamper-evident audit log (JSONL + hash chain)** | ❌ | ✅ |
| **Project/hub allow-list enforcement** | ❌ | ✅ |
| **Read-only mode toggle** (`FORMA_READONLY=true`) | ❌ | ✅ |
| **Per-tool hourly rate governance** | ❌ | ✅ |
| **Business-rule validators** | ❌ | ✅ |
| TypeScript strict mode | Partial | ✅ |

---

## Quickstart

### Step 1 — APS credentials (one-time)

You need an **Autodesk Platform Services (APS)** application with an **SSA (Secure Service Account)**. SSA is a bot identity that can be scoped to specific projects without a human login.

See [docs/AUTH.md](docs/AUTH.md) for the full walkthrough. Quick summary:

1. Create an app at [aps.autodesk.com](https://aps.autodesk.com) → enable **Autodesk Construction Cloud** APIs
2. App → **Security → Service Accounts** → generate key pair → download the PEM private key (never commit it)
3. Note your `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `SSA_ID`, `SSA_KEY_ID`, and the path to the PEM file
4. **Hub Admin → Members** → invite the SSA email → assign Project Admin role
5. **Hub Admin → Custom Integrations** → add your app by Client ID (required — without this, all project calls return 403)

### Step 2 — Configure env

Create a `.env` file in the project root (or pass these as env vars in your MCP client config — see Step 3):

```env
APS_AUTH_MODE=ssa
APS_CLIENT_ID=your_client_id
APS_CLIENT_SECRET=your_client_secret
SSA_ID=your_ssa_id
SSA_KEY_ID=your_key_id
SSA_KEY_PATH=/absolute/path/to/private-key.pem
```

Full variable reference: [Configuration](#configuration)

### Step 3 — Add to your MCP client

This server communicates over **stdio** (JSON-RPC). It is spawned by your MCP client — not run standalone in a terminal.

**Option A — npx** *(no clone needed; requires the package to be published on npm)*

```json
{
  "mcpServers": {
    "forma": {
      "command": "npx",
      "args": ["-y", "acc-forma-mcp-server"],
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

**Option B — Clone and build locally**

```bash
git clone https://github.com/KenLP/acc-forma-mcp-server.git
cd acc-forma-mcp-server
pnpm install
pnpm build
```

Then point your MCP client at the built file:

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

> **Tip:** Pass credentials via `env` in the MCP client config (as shown above) rather than relying on a `.env` file. The working directory when your client spawns the process may not be the repo root.

**MCP client config file locations**

| Client | Config path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| VS Code (MCP extension) | `.vscode/mcp.json` in your workspace |

---

## Available Tools

## Tools (39)

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

### Issues (11)

| Tool | Purpose |
|---|---|
| `issues_list` | List issues in a project with filters (status, type, assignee). |
| `issues_get` | Get a single issue with full details, including `permittedStatuses` and `permittedAttributes` for the current user. |
| `issues_create` ✍️ | Create a new issue with subtype, location, due date, assignment, and optional pushpin links. |
| `issues_update` ✍️ | Update an existing issue — status, title, description, assignee, due date, subtype, location (sparse PATCH; only provided fields change). |
| `issues_add_comment` ✍️ | Add a comment to an existing issue. |
| `issues_list_comments` | List the comment thread on an issue, paginated. |
| `issues_list_types` | List valid issue types and subtypes (with `isActive` flag) for a project. |
| `issues_list_root_causes` | List configured root cause categories for a project. |
| `issues_get_user_me` | Get the current identity's permission flags for the Issues module (canCreate, canUpdate, canCreateComments). |
| `issues_list_attrs` | List custom attribute definitions for a project — use to get UUIDs needed by `customAttributes` in create/update. |
| `issues_list_attachments` | List files and links attached to an issue, paginated. |

> **Status values (confirmed from live ACC API):** `draft` \| `open` \| `pending` \| `in_review` \| `closed` \| `void`. Valid transitions depend on the project workflow — check `permittedStatuses` from `issues_get` before updating.

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
| `aecdm_query_element_positions` | Query elements with origin position (x, y, z) **in metres**, plus each element's `external_id` (Revit UniqueId). Primary use: populate ACC Issue pushpins. For a 3D pin, convert to viewer space first: `metres × 3.280839895 − globalOffset` (imperial). NOTE: returns an origin *point* (not an AABB). Only point-placed elements (Pipe Fittings, Fixtures, Columns, Doors) have geometry — linear (Pipes, Ducts) and planar (Walls, Floors) return `position: null`. Uses the AECDM `geometryDataByElements` Public Beta field. |

### Model Derivative — SVF2 Translation (3)

| Tool | Purpose |
|---|---|
| `md_get_manifest` | Check SVF2 translation status and list available 3D/2D view GUIDs for a model version. |
| `md_get_properties` | Fetch Revit element properties (names, parameters, category) from an SVF2-translated model. Supports category and objectId filters. |
| `md_trigger_translation` ✍️ | Submit a new SVF2 translation job for a model version. Poll with `md_get_manifest`. |

> **Note:** bounding boxes are NOT available from the MD Properties API for any SVF2 model — this is an APS platform limitation. For element bboxes, the Model Properties API (`/construction/index/v2/`) is the correct path (requires 3LO auth — Phase 3).

### ACC Docs — Viewables (1)

| Tool | Purpose |
|---|---|
| `docs_get_viewables` | Resolve the ACC Docs-native **`viewableId`** (e.g. `"Layout1"`) and page/sheet name(s) for a document version URN, so you can place a 2D PDF pushpin (`issues_create` with `type=TwoDRasterPushpin`). This is the manifest `viewableID` field — **distinct from the SVF2 `guid`** returned by `md_get_manifest`, which the markups service rejects for raster PDF pins. `markupCapable: false` means the document has no Docs-native viewable yet (e.g. a raw PDF uploaded via the DM API that ACC has not processed — re-publish through ACC Docs or the Sheets API). |

### Meta / Observability (2)

| Tool | Purpose |
|---|---|
| `meta_list_changelog` | Read the local audit log entries with filters by tool, time, or project. |
| `meta_verify_audit_chain` | Verify the audit log hash chain has not been tampered with. |


More tools in Phase 3 (Model Properties API — bbox/clash; 3LO auth required).

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

Tool: issues_create(dry_run=true)
→ {
    preview: { method: "POST", url: "...issues", body: {...} },
    approval_token: "appr_01JXW...",
    next_step: "Re-call with dry_run=false and approval_token to execute"
  }

Tool: issues_create(dry_run=false, approval_token="appr_01JXW...")
→ Issue created: ID abc-456
```

### 2. Tamper-evident audit log

All tool calls are appended to `~/.acc-forma-mcp/audit/audit-YYYY-MM-DD.jsonl` with SHA-256 hash chaining. Verify integrity at any time:

```bash
# Using the MCP tool
meta_verify_audit_chain()

# Or read the JSONL directly — one JSON object per line
cat ~/.acc-forma-mcp/audit/audit-$(date +%F).jsonl | jq .
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
| `FORMA_AUDIT_FAIL_CLOSED` | `false` | Surface audit write failures as errors. When `true` and the write fails after an APS mutation, the response indicates whether the change was applied. |

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

## License

MIT — see [LICENSE](LICENSE).

**Not affiliated with Autodesk, Inc.** Autodesk Forma®, Autodesk Construction Cloud®, and Autodesk Platform Services® are trademarks of Autodesk, Inc.
