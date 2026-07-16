# Autodesk Marketplace — MCP Publisher Submission Pack

> Prepared 2026-07-07 for `acc-forma-mcp-server` v0.1.0 (tag pushed).
> Source guide: https://aps.autodesk.com/marketplace/mcp-publisher-guide
> Declaration form: https://airtable.com/appHPAcNTdVz1ff79/pagR4kGoN4qjIYGGY/form
> Section 4 dưới đây khớp **từng field thật** của form (đã đối chiếu screenshot form ngày 2026-07-07).

---

## 1. Kết quả review `mcp-manifest.json`

**Đánh giá tổng thể: ĐẠT — sau 2 chỉnh sửa (đã sửa xong, commit `fb54fdb`).**

| Hạng mục | Kết quả |
|---|---|
| Tool inventory | ✅ **43/43 khớp code** — đối chiếu tự động manifest ↔ `src/tools/_registry.ts`: không thiếu, không thừa, không sai tên |
| Cờ `mutating` | ✅ Khớp 100% với `kind: 'read' / 'mutation'` trong từng tool def (7 mutation: issues_create/update/add_comment/pin_element, reviews_create/transition, md_trigger_translation) |
| `server.name` / `version` | ✅ Khớp `src/server.ts` (`acc-forma-mcp-server` / `0.1.0`) và `package.json`; tag `v0.1.0` đã push |
| `repository` | ✅ `github.com/KenLP/acc-forma-mcp-server` — **PUBLIC**, license MIT có file LICENSE |
| `resources` / `prompts` rỗng | ✅ Đúng — server chỉ đăng ký tools, không có MCP resources/prompts |
| `ai_llm_providers: []` | ✅ Đúng — server KHÔNG tự gọi LLM nào; LLM là client phía trên |
| `mcp_spec_version` | ✅ Khớp ví dụ trong guide chính thức |
| `app_model` | ✅ `"Local MCP Server"` — khớp đúng option trên form. Guide chỉ đưa ví dụ `"A"` mà không định nghĩa A/B/C, nên dùng thẳng nhãn của form cho khỏi mơ hồ |
| Security controls | ✅ Khớp thực tế: dry-run, approval token, allow-list, readonly mode, rate governance, audit hash-chain |
| `external_endpoints` | ⚠️ **ĐÃ SỬA** — thiếu domain S3 (xem dưới) |
| `auth.notes` | ⚠️ **ĐÃ SỬA** — mô tả 2LO chưa đúng phạm vi (xem dưới) |

### 2 lỗi đã sửa

1. **Thiếu endpoint `*.amazonaws.com`** — `mc_list_clashes` tải 3 file kết quả clash từ **pre-signed S3 URL** do Autodesk cấp (TTL ~60s, không gửi bearer). Guide yêu cầu *"All external domains must be declared in manifest and form"* → thiếu domain này là lý do reject điển hình. Đã thêm entry: chỉ download, không upload, URL do Autodesk phát hành.
2. **`auth.notes` ghi "2LO chỉ dùng cho Account Admin"** — sai: 2LO là auth *ưu tiên* (`preferredAuth: '2lo'`) cho cả DM (6 tools), MD (3 tools), `docs_get_viewables`, với SSA fallback. Đã viết lại chính xác + bổ sung: *"Credentials are supplied by the customer via environment variables; the server ships with no credentials."*

---

## 2. Ảnh hưởng tới codebase / docs / BIM-orchestrator

### Codebase: KHÔNG ảnh hưởng runtime
- `mcp-manifest.json` là **file mô tả tĩnh** ở repo root. Không dòng code nào đọc nó — không import, không vào `dist/`, không đụng SEA/exe pipeline, không đụng `core` subpath.
- Publish = gửi manifest + form. **Không đổi transport, API surface, env vars.**

### BIM-orchestrator: AN TOÀN tuyệt đối
- BIM-orchestrator tiêu thụ qua (a) `acc-forma-mcp-server/core` import, (b) spawn MCP server qua stdio — cả hai không liên quan manifest. Guard test `env-free.spec.ts` vẫn pass.
- Chỉ khi marketplace review yêu cầu ĐỔI TÊN tool thì mới chạm codebase — lúc đó check BIM-orchestrator nếu nó hardcode tên tool.

### Docs: 1 nghĩa vụ duy trì mới (đã cập nhật)
- `CLAUDE.md` → "Adding a new tool" đã thêm **bước 5: đồng bộ `mcp-manifest.json`** (tên + mô tả + cờ mutating + external domain mới). Manifest phải luôn khớp code vì Autodesk review dựa trên khai báo này.

---

## 3. Các bước publish

1. **Manifest** — ✅ xong (`mcp-manifest.json`, đã sửa 2 lỗi).
2. **Tag release** — ✅ `v0.1.0` đã push.
3. **Điền form Airtable** — copy từng ô ở Section 4 dưới.
4. **Email `appsubmissions@autodesk.com`** — đính kèm `mcp-manifest.json` + xác nhận đã nộp form (template Section 5).
5. **Theo dõi Publisher Corner** — reject thì sửa theo feedback, nộp lại.

---

## 4. Nội dung điền form — khớp từng field thật

### 🔹 App Model — *"Which MCP architecture does your plugin use?"* (dropdown)

**Chọn: `Local MCP Server`**

Server chạy `transport: "stdio"` như một process cục bộ trên máy khách (`node dist/index.js`, do MCP client spawn), khách tự cấp credentials qua env. Không nhúng trong app nào (→ không phải *Embedded MCP App*), không host ở đâu và không có HTTP endpoint (→ không phải *Remote MCP Server*).

Manifest khai `"app_model": "Local MCP Server"` — đúng nhãn của form. (Guide chỉ đưa ví dụ `"A"` mà không định nghĩa A/B/C ở bất kỳ đâu, nên dùng nhãn form là cách duy nhất không mơ hồ.)

### 🔹 MCP Tools — *"List each MCP tool and briefly describe what it does in plain language"*

Copy nguyên khối sau (43 tools, đúng format mẫu `name – description` của form):

```
admin_list_projects – lists all projects under an ACC account (admin read)
admin_get_project – reads a single project's metadata and scopes
admin_list_users – lists users on the account or project roster
admin_list_companies – lists companies registered on the account
dm_list_hubs – lists ACC/BIM 360 hubs the app can access
dm_list_projects – lists projects within a hub
dm_list_top_folders – lists a project's top-level folders
dm_list_folder_contents – lists files and subfolders inside a folder
dm_get_item – reads metadata for a single file or folder
dm_list_versions – lists all versions of a file with timestamps
issues_list – lists issues in a project, filterable by status/type/assignee
issues_get – reads full details of a single issue
issues_create – creates a new issue (WRITE — dry-run preview + approval token required)
issues_pin_element – creates an issue with a 3D pushpin placed on a BIM element (WRITE — gated)
issues_update – updates fields on an existing issue via partial update (WRITE — gated)
issues_add_comment – adds a comment to an issue (WRITE — gated)
issues_list_comments – lists the comment thread on an issue
issues_list_types – lists the issue types and subtypes configured for a project
issues_list_root_causes – lists the configured root-cause categories
issues_get_user_me – reads the caller's permission flags for the Issues module
issues_list_attrs – lists custom attribute definitions for a project's issues
issues_list_attachments – lists files and links attached to an issue
reviews_list – lists reviews in a project's Reviews container
reviews_get – reads a single review with status and reviewers
reviews_create – creates a new review with reviewers and due date (WRITE — gated)
reviews_transition – moves a review between workflow states (WRITE — gated)
aecdm_list_hubs – lists AEC Data Model hubs
aecdm_list_projects – lists projects within an AEC Data Model hub
aecdm_list_element_groups – lists BIM model files published to a project
aecdm_list_categories – lists BIM element categories present in a model
aecdm_query_elements – queries BIM elements by category with their property sets
aecdm_get_element_properties – reads the full property set of one element
aecdm_aggregate_by_parameter – counts elements grouped by a parameter value
aecdm_query_element_positions – reads element origin positions (x, y, z) used to place issue pushpins
md_get_manifest – checks a model version's SVF2 translation status and lists viewables
md_get_properties – reads Revit element parameters from a translated model, with grouping/summing for take-offs
md_trigger_translation – submits an SVF2 translation job for a model version (WRITE — gated)
mc_list_modelsets – lists the coordination modelsets configured in a project
mc_list_clashes – reads clash-detection results for a modelset
mp_diff_versions – compares two versions of the same model, returning added/removed/modified elements by category
docs_get_viewables – resolves the ACC Docs-native viewable ID for a document version
meta_list_changelog – reads the server's local audit-log entries
meta_verify_audit_chain – verifies the local audit log's hash chain is untampered
```

### 🔹 MCP Resources / External Data Sources — *"List any external data sources the MCP server reads data from"*

```
Autodesk Platform Services (APS) APIs only, over HTTPS at developer.api.autodesk.com:
Account Admin, Data Management, Construction Issues, Construction Reviews, AEC Data
Model (GraphQL), Model Derivative, Model Coordination, and Model Properties.
Additionally, the Model Coordination API returns Autodesk-issued pre-signed S3 URLs
from which the server downloads clash-result files (download-only, ~60-second TTL).
No databases, no third-party cloud services, no other data sources. The server does
not expose MCP "resources" — tools only.
```

### 🔹 External Endpoints — *"List every external URL or domain the MCP component communicates with"*

```
1. https://developer.api.autodesk.com — all APS REST/GraphQL API calls and OAuth token
   requests (Account Admin, Data Management, Issues, Reviews, AEC Data Model, Model
   Derivative, Model Coordination, Model Properties).
2. https://*.amazonaws.com — Autodesk-issued pre-signed S3 URLs returned by the Model
   Coordination clash API, used to download clash-result resource files. Short-lived
   (~60 s), download-only, no bearer token attached, no data uploaded.
No other domains are contacted at runtime.
```

### 🔹 Endpoint Confirmation — *multi-select "Confirm the following"*

Tick **cả 2**:
- ☑ All external endpoints used by the plugin have been declared
- ☑ The plugin does not communicate with undeclared URLs or services

### 🔹 Autodesk Data Access — *"What Autodesk product data do the MCP tools read or modify?"*

```
Product: Autodesk Construction Cloud (ACC / Forma), via APS.

READ: account metadata (projects, users, companies); project folders, files and file
versions; issues (with comments, types, root causes, custom attributes, attachments);
reviews; BIM element data (categories, parameters/properties, element positions) from
the AEC Data Model and Model Derivative services; model-coordination clash results;
model-version diff results (added/removed/modified elements); document viewable IDs.

MODIFY (7 tools, all gated behind a dry-run preview + payload-bound approval token):
create/update issues, add issue comments, create an issue pinned to a BIM element,
create reviews, transition review workflow states, and submit Model Derivative (SVF2)
translation jobs. No project files are ever uploaded, modified, or deleted.
```

### 🔹 Purpose of Data Access — *"Explain why access to this Autodesk data is necessary"*

```
The server lets LLM agents run AEC/BIM coordination workflows conversationally:
BIM QC (query element parameters, quantity take-offs by level), issue management
(find, create, and update issues — including pinning them to the exact 3D element),
clash triage (read Model Coordination results and raise issues on clashing elements),
and cross-discipline change alerting (diff two model versions, detect which
categories changed, and open an issue for the affected discipline, e.g. structural
review when walls/columns change). Each tool reads the minimum data needed for that
workflow; write access is limited to issues, reviews, and translation jobs because
those are the deliverables of the workflows above, and every write requires an
explicit dry-run preview and approval token before execution.
```

### 🔹 AI / LLM Usage — *"Does the plugin send Autodesk data to an AI or LLM service?"* (Yes/No — không có ô ghi chú)

**Chọn: `No`**

Căn cứ (đã verify trong code):
- Server **không** gọi bất kỳ AI/LLM service nào: không có AI SDK, không có model đóng gói, không giữ credential của provider nào. Toàn bộ network egress chỉ gồm `developer.api.autodesk.com` + pre-signed S3 của Autodesk.
- Server trả kết quả qua **stdio về MCP host** — host là phần mềm của khách hàng, không phải "AI service". Việc dữ liệu có tới LLM hay không, và tới provider nào, do **client của khách hàng** quyết định và cấp consent.
- **Nhất quán với manifest** `"ai_llm_providers": []`. Chọn `Yes` sẽ buộc phải khai tên provider — mà ta không có provider nào để khai → tự mâu thuẫn hồ sơ.
- Câu hỏi này phân biệt server *tự gọi* AI (vd. gọi OpenAI để tóm tắt model — data đi tới bên thứ ba do publisher chọn) với server chỉ trả data về host. Nếu "Yes" đúng cho mọi MCP server thì câu hỏi vô nghĩa.

> ⚠️ Vì ô này không cho ghi chú, **phần khai luồng gián tiếp (data tới LLM qua client của khách) đã được đưa vào email nộp hồ sơ** (Section 5) — để không có gì bị coi là che giấu, và để không xung đột với ô Compliance *"No hidden or undeclared network communication exists"*.

### 🔹 Dynamic Tool Configuration — *"Does the plugin load MCP tools or capabilities dynamically from a remote configuration or service?"*

```
No. All 43 tools are statically defined in the source code and compiled into the
server at build time. There is no remote configuration, no dynamic tool loading, and
no capability download at runtime.
```

### 🔹 Data Retention and Security

**Data retention policy:**
```
The server is stateless with respect to Autodesk design data — no project data is
persisted beyond the records below. By default the only file written to disk is a
local audit log (JSONL) of tool calls on the customer's own machine, with
tokens/secrets redacted before writing. Approval tokens, rate counters, and
idempotency records are held in memory only by default and vanish on process exit.
If the customer opts into FORMA_PERSISTENCE_MODE=sqlite, a second file is also
written on the customer's own machine — a local SQLite database (state.db) holding
that same data, including cached tool results for idempotency replay, which can
contain Autodesk project data; expired rows are purged at startup. The publisher
receives no data of any kind (no telemetry, no analytics).
```

**Where data is stored:**
```
Only on the customer's machine: the local audit log defaults to
~/.acc-forma-mcp/audit (configurable via FORMA_AUDIT_DIR). Autodesk credentials are
supplied by the customer as environment variables and are never written to disk by
the server. Optionally, if FORMA_PERSISTENCE_MODE=sqlite is set, approval tokens, rate
counters, and idempotency records (default: memory-only) are persisted to a local
SQLite file at ~/.acc-forma-mcp/state.db (configurable via FORMA_DB_PATH). No
publisher-side or third-party storage exists.
```

**Data deletion process:**
```
Delete the local audit directory (~/.acc-forma-mcp/audit) and, if
FORMA_PERSISTENCE_MODE=sqlite was enabled, the local state.db file
(~/.acc-forma-mcp/state.db, or FORMA_DB_PATH), then unset the environment variables.
The server retains nothing else and the publisher holds no data, so removing those two
paths constitutes complete deletion.
```

**Publisher Privacy Policy URL** *(required by the App Store Getting Started checklist; provide if the form or reviewer asks):*
```
https://github.com/KenLP/acc-forma-mcp-server/blob/main/PRIVACY.md
```
Covers the 4 mandated points: (1) what data is collected/how/why, (2) third-party sharing (Autodesk only; same-protection statement), (3) retention + deletion (90-day audit-log default, `FORMA_AUDIT_RETENTION_DAYS`), (4) how to revoke consent / delete data. Linked from the README (the "App description page" equivalent).

**Security certifications (if any):**
```
None. This is an open-source (MIT) project; no formal certification has been
obtained. Compensating controls are built in: dry-run-first mutations with
payload-bound approval tokens, hub/project allow-lists, a global read-only mode,
per-tool rate governance, and a SHA-256 hash-chained audit log that is independently
verifiable via the meta_verify_audit_chain tool.
```

### 🔹 Compliance Confirmation — *multi-select "Confirm the following"*

Tick **cả 4**:
- ☑ All MCP tools declared are required for plugin functionality
- ☑ All external endpoints have been disclosed
- ☑ No hidden or undeclared network communication exists
- ☑ The plugin follows Autodesk MCP security and data usage requirements

### 🔹 Contact Information — *Email ID* (bắt buộc)

```
ken.lephuc@gmail.com
```

---

## 5. Email nộp hồ sơ (template)

```
To:      appsubmissions@autodesk.com
Subject: MCP Server Submission — acc-forma-mcp-server v0.1.0

Hello Autodesk Marketplace team,

I would like to submit an MCP server for marketplace review.

  • Server:      acc-forma-mcp-server v0.1.0 (stdio, Local MCP Server)
  • Repository:  https://github.com/KenLP/acc-forma-mcp-server  (public, MIT, tag v0.1.0)
  • Manifest:    attached (mcp-manifest.json, mcp_manifest_version 1.0)
  • Privacy policy: https://github.com/KenLP/acc-forma-mcp-server/blob/main/PRIVACY.md
  • Publisher Declaration Form: submitted via the Airtable form on <DATE>

Summary: a safety-first MCP server exposing ACC/Forma APIs (Data Management,
Issues, Reviews, AEC Data Model, Model Derivative, Model Coordination, Model
Properties) as 43 tools. In the default mode (preview_required), all 7 mutating
tools require a dry-run preview and a payload-bound approval token; all calls
are hash-chain audit-logged, and the operator can also select a trusted-client
mode or a global read-only mode (all three are disclosed in the manifest).
External endpoints: developer.api.autodesk.com and Autodesk-issued pre-signed
S3 URLs (download-only). No dynamic tool loading — the tool registry is static
and compiled in.

One clarification on the form's AI/LLM Usage question, which I answered "No":
the server itself calls no AI/LLM service — it bundles no AI SDK or model, holds
no AI provider credentials, and its only network egress is the two endpoints
above (hence ai_llm_providers is empty in the manifest). For completeness, and as
is inherent to MCP: tool results are returned over stdio to whichever MCP client
the customer runs, and that client is typically an LLM agent. Which LLM (if any)
receives the data is entirely the customer's choice, configuration, and consent —
the server neither selects, contracts with, nor transmits to any AI provider.

Contact: Ken Le — ken.lephuc@gmail.com

Thank you,
Ken
```

---

## 6. Sau khi được duyệt — nghĩa vụ duy trì

1. **Mỗi lần thêm/sửa/xóa tool** → cập nhật `mcp-manifest.json` cùng commit (CLAUDE.md "Adding a new tool", bước 5) — và nhớ khai lại form nếu thay đổi lớn.
2. **Thêm external domain mới** → khai báo vào manifest **và** form.
3. **Bump version** đồng bộ 3 chỗ: `package.json`, `src/server.ts`, `mcp-manifest.json` (+ git tag).
4. Theo dõi **Publisher Corner** để nhận feedback từ Autodesk.
