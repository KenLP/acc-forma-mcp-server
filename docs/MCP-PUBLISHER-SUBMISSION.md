# Autodesk Marketplace — MCP Publisher Submission Pack

> Prepared 2026-07-07 for `acc-forma-mcp-server` v0.1.0.
> Source guide: https://aps.autodesk.com/marketplace/mcp-publisher-guide
> Declaration form: https://airtable.com/appHPAcNTdVz1ff79/pagR4kGoN4qjIYGGY/form

---

## 1. Kết quả review `mcp-manifest.json`

**Đánh giá tổng thể: ĐẠT — sau 2 chỉnh sửa (đã sửa xong).**

| Hạng mục | Kết quả |
|---|---|
| Tool inventory | ✅ **43/43 khớp code** — đối chiếu tự động manifest ↔ `src/tools/_registry.ts`: không thiếu, không thừa, không sai tên |
| Cờ `mutating` | ✅ Khớp 100% với `kind: 'read' / 'mutation'` trong từng tool def (7 mutation: issues_create/update/add_comment/pin_element, reviews_create/transition, md_trigger_translation) |
| `server.name` / `version` | ✅ Khớp `src/server.ts` (`acc-forma-mcp-server` / `0.1.0`) và `package.json` |
| `repository` | ✅ `github.com/KenLP/acc-forma-mcp-server` — **PUBLIC**, license MIT có file LICENSE |
| `resources` / `prompts` rỗng | ✅ Đúng — server chỉ đăng ký tools, không có MCP resources/prompts |
| `ai_llm_providers: []` | ✅ Đúng — server KHÔNG tự gọi LLM nào; LLM là client phía trên |
| `mcp_spec_version` / `app_model: "A"` | ✅ Khớp ví dụ trong guide chính thức |
| Security controls | ✅ Khớp thực tế: dry-run, approval token, allow-list, readonly mode, rate governance, audit hash-chain |
| `external_endpoints` | ⚠️ **ĐÃ SỬA** — thiếu domain S3 (xem dưới) |
| `auth.notes` | ⚠️ **ĐÃ SỬA** — mô tả 2LO chưa đúng phạm vi (xem dưới) |

### 2 lỗi đã sửa (commit cùng file này)

1. **Thiếu endpoint `*.amazonaws.com`** — `mc_list_clashes` tải 3 file kết quả clash từ **pre-signed S3 URL** do Autodesk cấp (TTL ~60s, không gửi bearer). Guide yêu cầu *"All external domains must be declared in manifest and form"* → thiếu domain này là lý do reject điển hình. Đã thêm entry với mô tả rõ: chỉ download, không upload, URL do Autodesk phát hành.
2. **`auth.notes` ghi "2LO chỉ dùng cho Account Admin"** — sai: 2LO là auth *ưu tiên* (`preferredAuth: '2lo'`) cho cả DM (6 tools), MD (3 tools), `docs_get_viewables`, với SSA fallback. Đã viết lại chính xác + bổ sung câu quan trọng cho reviewer: *"Credentials are supplied by the customer via environment variables; the server ships with no credentials."*

---

## 2. Ảnh hưởng tới codebase / docs / BIM-orchestrator

### Codebase: KHÔNG ảnh hưởng runtime
- `mcp-manifest.json` là **file mô tả tĩnh** nằm ở repo root. Không có dòng code nào đọc nó — không import, không bundle vào `dist/`, không đụng SEA/exe pipeline, không đụng `core` subpath.
- Việc publish = gửi manifest + form qua email. **Không đổi transport, không đổi API surface, không đổi env vars.**

### BIM-orchestrator: AN TOÀN tuyệt đối
- BIM-orchestrator tiêu thụ qua 2 kênh: (a) `acc-forma-mcp-server/core` subpath (import trực tiếp), (b) spawn MCP server qua stdio. Cả hai **không liên quan** tới manifest.
- Không có breaking change nào đi kèm việc publish. Guard test `env-free.spec.ts` vẫn pass — core subpath không đổi.
- Điều duy nhất cần nhớ: nếu sau này marketplace review yêu cầu đổi tên tool / mô tả tool, đó MỚI là thay đổi chạm codebase — khi đó check lại BIM-orchestrator nếu nó hardcode tên tool.

### Docs: 1 nghĩa vụ duy trì mới (đã cập nhật)
- `CLAUDE.md` → mục "Adding a new tool" đã thêm **bước 5: đồng bộ `mcp-manifest.json`** (tên + mô tả + cờ mutating + external domain mới nếu có). Đây là nghĩa vụ duy trì duy nhất phát sinh: **manifest phải luôn khớp code** ở mỗi lần thêm/sửa tool, vì Autodesk review dựa trên khai báo này.
- README không bắt buộc đổi; đã có sẵn Quickstart / Tools(43) / Safety Guardrails / Configuration / License — đủ cho reviewer đối chiếu.

### Rủi ro còn lại (thấp)
- **`app_model: "A"`**: guide chỉ đưa ví dụ "A" mà không định nghĩa các model — khi điền form nếu có field App Model với các lựa chọn được mô tả, chọn model tương ứng "locally-run / stdio / customer-supplied credentials". Nếu mô tả không khớp, hỏi lại qua appsubmissions@autodesk.com trước khi nộp.
- Manifest ghi `mcp_spec_version: 2025-11-25` — đúng theo ví dụ guide; SDK MCP đang dùng trong repo tương thích.

---

## 3. Các bước publish (theo guide chính thức)

1. **Chuẩn bị manifest** — ✅ xong: `mcp-manifest.json` ở repo root (đã sửa 2 lỗi trên).
2. **Điền Publisher Declaration Form** (Airtable link ở đầu file) — dùng nội dung Section 4 dưới đây. Form là các cam kết bảo mật (security attestations) + thông tin publisher.
3. **Gửi email tới `appsubmissions@autodesk.com`** — đính kèm `mcp-manifest.json` + xác nhận đã nộp form. Template email ở Section 5.
4. **Theo dõi phản hồi qua Publisher Corner** (trong tài khoản APS của bạn). Nếu bị reject → sửa theo feedback → nộp lại.

**Checklist trước khi bấm gửi:**
- [ ] Repo public, README quickstart chạy được từ đầu (clone → build → config → connect)
- [ ] `mcp-manifest.json` valid JSON, 43 tools, 2 external endpoints
- [ ] Không có credential nào trong repo (`.env` gitignored — đã đúng)
- [ ] Tag release `v0.1.0` trên GitHub (khuyến nghị — reviewer thấy version khớp manifest): `git tag v0.1.0 && git push origin v0.1.0`

---

## 4. Nội dung điền form (tiếng Anh — copy-paste theo từng chủ đề)

> Form Airtable render bằng JS nên chưa đọc được label chính xác từng field.
> Nội dung dưới đây phủ **mọi chủ đề guide nói form sẽ hỏi** (publisher info, data access,
> external connections, AI providers, security attestations) + các field chuẩn của một
> marketplace listing. Khi mở form, map từng đoạn vào field tương ứng.

### 4.1 Publisher information

| Field (dự kiến) | Nội dung điền |
|---|---|
| Publisher / Developer name | `Ken Le (KenLP)` *(chỉnh theo tên bạn muốn hiển thị công khai)* |
| Contact email | `ken.lephuc@gmail.com` |
| Company / Organization | *(điền nếu nộp danh nghĩa công ty; nếu cá nhân, ghi "Individual developer")* |
| Website / Repository | `https://github.com/KenLP/acc-forma-mcp-server` |
| Support channel | `https://github.com/KenLP/acc-forma-mcp-server/issues` |

### 4.2 Server identity

| Field | Nội dung |
|---|---|
| MCP server name | `acc-forma-mcp-server` |
| Version | `0.1.0` |
| Transport | `stdio` (local process; the customer runs it on their own machine/CI) |
| License | `MIT` |
| App model | `A` |
| MCP spec version | `2025-11-25` |

### 4.3 Short description (~1–2 câu, cho listing)

> Safety-first MCP server that gives LLM agents governed access to Autodesk Construction Cloud (Forma): read project data, BIM elements, clashes and version diffs — and create Issues/Reviews only through a dry-run → approval-token → audit-logged pipeline.

### 4.4 Long description

> **acc-forma-mcp-server** exposes Autodesk Construction Cloud (ACC / Forma) and Autodesk Platform Services (APS) APIs as 43 MCP tools for AEC/BIM workflows: project & document navigation (Data Management), issue and review management (Construction Issues / Reviews), BIM element queries (AEC Data Model GraphQL, Model Derivative SVF2), clash detection results (Model Coordination), and cross-version change detection (Model Properties diff — the engine behind ACC's Compare Versions).
>
> It is designed **safety-first** for agent use:
> - Every mutating tool defaults to `dry_run=true` and returns a human-reviewable preview plus a payload-bound approval token; nothing executes without an explicit second call carrying that token.
> - A project/hub allow-list, a global read-only mode, and per-tool rate governance restrict blast radius.
> - Every call is written to a SHA-256 hash-chained local audit log, independently verifiable via a built-in tool (`meta_verify_audit_chain`).
>
> Typical uses: BIM QC automation (find issues, pin them to 3D elements), cross-discipline change alerts (diff model versions, route changes to the affected team as ACC Issues), quantity take-offs by level, and clash triage — all driven conversationally by an LLM client.

### 4.5 Data access (guide: "access minimum required data only")

> The server accesses only the ACC hubs/projects the customer explicitly grants:
> - **Auth is customer-supplied.** The server ships with no credentials. The customer creates their own APS app + Secure Service Account (SSA) and grants it to specific projects via Hub Admin → Custom Integrations. 2-legged OAuth (app-only) is used for Account Admin / Data Management / Model Derivative reads where applicable.
> - **Scope minimization:** OAuth scopes requested are `data:read`, `data:write` (only for the 7 mutating tools), and `account:read`.
> - **Allow-list:** `FORMA_ALLOWED_HUBS` / `FORMA_ALLOWED_PROJECTS` environment variables restrict the server to named hubs/projects; everything else is refused before any API call.
> - **No data retention:** the server is stateless with respect to design data — nothing is stored except a local audit log (JSONL on the customer's machine) whose entries are redacted of tokens/keys before write.
> - **No telemetry:** the server sends nothing to the publisher or any third party.

### 4.6 External connections (guide: declare ALL domains, HTTPS only)

| Domain | Purpose | Protocol |
|---|---|---|
| `developer.api.autodesk.com` | All APS REST/GraphQL calls: Account Admin, Data Management, Construction Issues, Construction Reviews, AEC Data Model, Model Derivative, Model Coordination, Model Properties | HTTPS |
| `*.amazonaws.com` | Autodesk-issued **pre-signed S3 URLs** returned by the Model Coordination clash API, used to download clash-result resource files. Short-lived (~60 s TTL), download-only, no bearer token attached, no data uploaded | HTTPS |

> All connections are HTTPS. No other domains are contacted at runtime.

### 4.7 AI / LLM providers (guide: declare providers receiving data)

> **None.** The server itself makes no calls to any AI/LLM provider. It is a data/tool layer consumed *by* an MCP client (e.g. Claude, or any MCP-compatible agent) that the customer chooses and configures. What data reaches an LLM is decided entirely by the customer's client-side configuration and consent.

### 4.8 Security attestations (các câu cam kết thường gặp — trả lời sẵn)

| Attestation | Answer + evidence |
|---|---|
| Tool descriptions accurately describe behavior in plain language | **Yes** — descriptions reviewed against implementation; mutating tools are flagged and describe their write action explicitly |
| Server accesses only minimum required data | **Yes** — scopes `data:read/write`, `account:read`; hub/project allow-list; customer-granted SSA |
| All external endpoints declared & HTTPS | **Yes** — see 4.6; enforced in code (no plain-HTTP path exists) |
| No sensitive data in tool descriptions | **Yes** — descriptions contain API semantics only |
| Credentials handling | Customer-supplied via environment variables; never logged (audit writer redacts tokens/keys); never transmitted anywhere except Autodesk's token endpoint |
| Mutations are controlled | **Yes** — dry-run preview by default, payload-bound approval token required to execute, global read-only mode available (`FORMA_MUTATION_MODE=readonly`) |
| Audit capability | **Yes** — SHA-256 hash-chained JSONL audit log of every tool call, verifiable via `meta_verify_audit_chain` |
| Vulnerability reporting / support | GitHub Issues on the public repository; maintainer responds via listed contact email |

### 4.9 Category / tags (nếu form có)

> Category: **AEC / Construction / BIM**
> Tags: `ACC`, `Forma`, `BIM`, `Issues`, `Clash Detection`, `Model Compare`, `AEC Data Model`, `Model Derivative`, `agent`, `MCP`

---

## 5. Email nộp hồ sơ (template)

```
To:      appsubmissions@autodesk.com
Subject: MCP Server Submission — acc-forma-mcp-server v0.1.0

Hello Autodesk Marketplace team,

I would like to submit an MCP server for marketplace review.

  • Server:      acc-forma-mcp-server v0.1.0 (stdio, App Model A)
  • Repository:  https://github.com/KenLP/acc-forma-mcp-server  (public, MIT)
  • Manifest:    attached (mcp-manifest.json, mcp_manifest_version 1.0)
  • Publisher Declaration Form: submitted via the Airtable form on <DATE>

Summary: a safety-first MCP server exposing ACC/Forma APIs (Data Management,
Issues, Reviews, AEC Data Model, Model Derivative, Model Coordination, Model
Properties) as 43 tools. All 7 mutating tools require a dry-run preview and a
payload-bound approval token; all calls are hash-chain audit-logged. External
endpoints: developer.api.autodesk.com and Autodesk-issued pre-signed S3 URLs
(download-only). No AI/LLM providers are called by the server.

Contact: Ken Le — ken.lephuc@gmail.com

Thank you,
Ken
```

---

## 6. Sau khi được duyệt — nghĩa vụ duy trì

1. **Mỗi lần thêm/sửa/xóa tool** → cập nhật `mcp-manifest.json` cùng commit (đã ghi vào CLAUDE.md "Adding a new tool", bước 5).
2. **Thêm external domain mới** (API mới, CDN mới) → khai báo vào manifest **và** cân nhắc có phải nộp lại form không.
3. **Bump version** trong cả 3 chỗ đồng bộ: `package.json`, `src/server.ts`, `mcp-manifest.json`.
4. Theo dõi **Publisher Corner** để nhận feedback/yêu cầu cập nhật từ Autodesk.
