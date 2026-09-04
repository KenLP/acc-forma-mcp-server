# Audit: Autodesk MCP Publisher Guide conformance — 2026-07-22

**Nguồn chuẩn:** Autodesk MCP Publisher Guide — <https://aps.autodesk.com/marketplace/mcp-publisher-guide>
Fetch: 2026-07-22 (HTTP 200, 43 795 bytes, browser UA; nội dung điều hướng + 15 FAQ accordion nhúng dạng JSON trong trang, đã extract toàn bộ). Server không phát `Last-Modified`.

**Phạm vi artifacts:** `mcp-manifest.json`, `README.md`, `PRIVACY.md`, và mô tả tool thật của MCP server.
**Trạng thái audit:** working tree hiện tại (v0.1.4 = commit `001b313`, +2 commit `ec6e7fe` webhooks, `234fb05` core-subpath). `dist/index.js` build 2026-07-19 khớp working tree.

**Reviewer:** session context-sạch, độc lập. `REVIEW_FINDINGS_*.md` trong repo **không** được dùng làm bằng chứng — mọi verdict đến từ tài liệu guide gốc + đọc code thật + probe protocol thật.

---

## Phương pháp probe interface thật (Quy tắc interface thật — Bước 4)

Khởi động server đã build ở stdio bằng **MCP client thật** (`@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`), gọi `tools/list` qua protocol JSON-RPC thật, đọc output thật. Client giả (`APS_CLIENT_ID/SECRET=dummy`, `APS_AUTH_MODE=2lo`) — `tools/list` không cần credential Autodesk. Probe phân biệt 3 trạng thái: OK / SERVER_ERROR (in stderr server) / TIMEOUT — silence không đọc thành pass.

**Kết quả probe:** `PROBE_RESULT: OK`, `TOOL_COUNT: 46`, exit 0, stderr rỗng. (Đăng ký tool trong `src/server.ts` lặp `toolRegistry` **không phụ thuộc auth mode** — chỉ execution mới bị gate — nên danh sách ở 2lo = danh sách ở ssa.)

Probe egress: đọc code thật `src/http/client.ts`, `src/utils/url-guard.ts`, `src/apis/*` để xác định mọi host outbound và enforcement HTTPS/host-allowlist. Probe file tạm đã xoá; working tree sạch.

---

## Ma trận requirement (20 dòng): ✅ 16 | ❌ 0 | 👁 2 | 📭 2

| id | Yêu cầu (quote guide) | Nguồn | Verify | Trạng thái |
|----|----------------------|-------|--------|-----------|
| R1 | "you must submit an MCP Tool Manifest (JSON)" | FAQ Getting started | probe: `JSON.parse(mcp-manifest.json)` OK | ✅ |
| R2 | "It must include your app model" — "Local (A): Runs on the user's machine" | Manifest §, FAQ model | code: `app_model:"A"`; server chạy stdio local, publisher operates no server (PRIVACY §2) → không phải B(no-ext)/C(hosted) | ✅ |
| R3 | Manifest có `mcp_manifest_version`, `mcp_spec_version` | Example manifest | code: `1.0` / `2025-11-25` (khớp mẫu guide) | ✅ |
| R4 | "All tools with names and plain-language descriptions" | What to include | probe `tools/list`: 46 tool, tên khớp manifest **1:1** (0 lệch mỗi chiều), mọi tool có description | ✅ |
| R5 | Manifest liệt kê resources | What to include | probe+code: `resources:[]`; `server.ts` chỉ gọi `server.tool()`, không đăng ký resource | ✅ |
| R6 | Manifest liệt kê prompts | What to include | probe+code: `prompts:[]`; không đăng ký prompt | ✅ |
| R7 | Manifest liệt kê external_endpoints | What to include | code: `developer.api.autodesk.com`, `*.amazonaws.com` (+ disclosure webhook callback) | ✅ |
| R8 | Manifest liệt kê autodesk_apis_used | What to include | code: 11 mục, khớp `src/apis/*.ts` | ✅ |
| R9 | Manifest liệt kê ai_llm_providers | What to include | code: `[]`; không dep AI, không egress AI (xem R17) | ✅ |
| R10 | "Undeclared external endpoints" = lỗi phải tránh; behavior khớp manifest | Common mistakes | code: host outbound duy nhất `developer.api.autodesk.com` (base + `/aec/graphql` + NDJSON) và `*.amazonaws.com` (clash S3), **enforce runtime** bằng `assertAllowedUrl` (`url-guard.ts`: `exactHosts`/`hostSuffixes`). `aps.autodesk.com` chỉ trong comment doc | ✅ |
| R11 | "All external connections must use HTTPS" | Security list | code: `APS_BASE_URL='https://...'`; `url-guard.ts:27` chặn non-https; `callback-url.ts:78` chặn non-https; không có `http://` outbound | ✅ |
| R12 | "Tool descriptions must clearly describe what the tool does in plain language" | Security list | probe: 46 mô tả đều mô tả rõ chức năng | ✅ |
| R13 | "Don't include instructions ... in tool descriptions" | Security list | probe: không có instruction thao túng/tool-poisoning; heuristic chỉ bắt cụm mô tả hành vi ("before creating the issue", "newest first"). **Note:** scanner keyword ngây thơ có thể gắn cờ các gợi ý workflow (vd. `aecdm_query_element_positions` "×3.280839895 ... apply before use") | 👁 |
| R14 | "Don't include ... references to sensitive data in tool descriptions" | Security list | probe: scan `password/secret/token/key/credential/PEM/.env/ssh...` trên cả 46 mô tả thật + manifest → **0 hit** | ✅ |
| R15 | "Mismatches between the manifest and actual MCP server behavior" = lỗi phải tránh | Common mistakes | probe: tên 46/46 khớp; cờ mutation khớp **chính xác** (9 tool có `approval_token` = 9 tool `mutating:true`: issues_create/update/add_comment/pin_element, reviews_create/transition, md_trigger_translation, webhooks_create/delete) | ✅ |
| R16 | "Only access the minimum data required" / "Access to sensitive or unrelated data is not allowed" | Security list | code: `index.ts:35` scope tối thiểu `data:read, account:read`, thêm `data:write` chỉ khi ghi bật; **không** `account:write`. Phạm vi giới hạn ACC/APS BIM. Judgment: hợp lý, không có endpoint truy cập dữ liệu ngoài phạm vi | 👁 |
| R17 | "If your MCP server sends data to AI services, you must declare the provider ... obtain user consent" | Security list | code: **N/A** — không gửi gì cho AI. `package.json` không có dep AI/LLM; egress chỉ tới Autodesk; PRIVACY §"AI/LLM services" xác nhận. Điều kiện không kích hoạt | ✅ |
| R18 | "Tools must not change behavior after approval via remote configurations or updates" | FAQ Submission outcomes | code: `toolRegistry` tĩnh; không fetch config từ xa; egress chỉ tới data-API Autodesk (không có config server) | ✅ |
| R19 | "you must submit ... a completed Publisher Declaration Form" (Airtable) | FAQ Getting started | **Không có bản trong repo** — artifact tay ngoài repo (declaration-sync tầng 3). Không verify được | 📭 |
| R20 | "All external domains must be declared in **both** the manifest **and** declaration form" | FAQ External endpoints | Phía manifest ✅ (R7); phía form không có để đối chiếu | 📭 |

---

## Ma trận claim (9 dòng — artifacts đối ngoại): ✅ 7 | ❌ 0 | 👁 2

Quét README / PRIVACY / manifest, gắt với **all/every/always/never/only/exactly**.

| id | Claim (quote) | Artifact | Verify | Trạng thái |
|----|--------------|----------|--------|-----------|
| C1 | "Preview **every** write" / "**Every** write is dry-runnable" | README | probe: 9/9 tool mutation có `dry_run`+`approval_token`; default `preview_required` | ✅ |
| C2 | "**Audit every action**" | README tagline | code: đúng ở tầng handler, nhưng **fail-open mặc định** + reject ở protocol-layer **không** được audit. Chi tiết README §2 / PRIVACY §1.3 / manifest security_controls đã **định tính đầy đủ** 3 giới hạn này. Tagline là rút gọn marketing, phần chi tiết chính xác | 👁 |
| C3 | "The publisher receives **no** data from you — none, **ever**" | PRIVACY | code: 0 dep telemetry/analytics/sentry/segment...; egress chỉ Autodesk | ✅ |
| C4 | "shares your data with **exactly one** third party: Autodesk" / "**no other** network destinations" | PRIVACY | code: egress = `developer.api.autodesk.com` + `*.amazonaws.com` (URL presigned do Autodesk phát) — cả hai đều Autodesk | ✅ |
| C5 | credentials "**never** written to disk, **never** logged, **never** transmitted anywhere except Autodesk" | PRIVACY §1.1 | code: redactor `src/utils/redact.ts` (PRIVACY §1.3 liệt kê); bearer chỉ tới host khai báo (`url-guard`); không ghi credential ra disk | ✅ |
| C6 | `user_email` "**always** null in this release" | PRIVACY §1.3 | code: `audit-log.ts:117` hardcode `user_email: null` — site ghi duy nhất | ✅ |
| C7 | "does **not** send data to **any** AI or LLM service" | PRIVACY / manifest | code: khớp R17 | ✅ |
| C8 | S3 URLs "fetched **without any** bearer token" | manifest security_controls | code: `model-coordination.ts:216-217` — fetch S3 tách riêng, `assertAllowedUrl(.amazonaws.com)`; bearer chỉ đi tới APS host | ✅ |
| C9 | allow-list active → AECDM/MD/docs/pin/webhooks "**refused** outright" | manifest / README §3 | code: khai báo `scope` per-tool + `_wrap.ts` enforce tập trung (đọc code). **Chưa probe runtime** với allow-list cấu hình thật → chưa đọc side-effect thật | 👁 |

---

## Findings

**Không có finding P0/P1 mới.** Cách đã verify để kết luận điều này (không dựa review notes cũ):

- Danh sách tool + mô tả đọc từ `tools/list` qua **protocol MCP thật** (không phải grep source) — 46/46 khớp manifest, cờ mutation khớp chính xác, mô tả sạch sensitive-data, HTTPS + host-allowlist **enforce ở runtime** chứ không chỉ khai báo.
- app_model "A" verify lại từ định nghĩa guide gốc (Local = chạy trên máy user) — đúng, không phải B/C. (Đây là điểm từng bị sửa ở `d0c253c`; nay xác nhận đúng.)
- Các claim absolute (`always null`, `no AI`, `no telemetry`, `exactly one third party`) verify tới site code / danh sách dep, không tới ghi chú.

### F1 (Low / 👁) — `external_endpoints[2].domain` không phải hostname literal
`"domain": "customer-specified webhook callback host"` là chuỗi mô tả, không phải domain/wildcard. Trung thực về mặt ngữ nghĩa (host do operator cung cấp; **server không tự kết nối** — Autodesk POST tới đó; đã ràng `https` + `FORMA_ALLOWED_CALLBACK_HOSTS` + chặn loopback/private ở `callback-url.ts`). Rủi ro: form/scanner Airtable kỳ vọng hostname có thể gắn cờ "định dạng lạ".
**Class đã quét:** cả 3 phần tử `external_endpoints` — 2 phần tử đầu là domain hợp lệ; chỉ phần tử webhook là mô tả.
**Đề xuất:** giữ nguyên disclosure (nó tăng minh bạch), nhưng ở Publisher Declaration Form ghi mục external-domain của webhook cùng cách diễn giải ("callback do operator cấu hình; server không egress tới đó") để manifest ↔ form không lệch (R20).

### F2 (Info / 📭) — Không audit được Publisher Declaration Form
Guide bắt buộc **cả** manifest **và** Declaration Form, và external domains phải khớp giữa hai bên (R19, R20). Form là artifact tay ngoài repo — không có bản trong repo để đối chiếu. Đây là khoảng trống nghiệm thu, không phải vi phạm.
**Đề xuất:** commit một snapshot câu trả lời form đã nộp (vd. `docs/submission/declaration-form.md`) để vòng audit sau cross-check được manifest ↔ form (đúng tinh thần declaration-sync tầng 3).

### F3 (Info / 👁) — Claim allow-list refusal chưa probe runtime (C9)
Hành vi "refuse AECDM/MD/webhooks khi allow-list hẹp" mới verify ở tầng code (`_wrap.ts` + `scope` declaration), **chưa** probe qua interface thật với `FORMA_ALLOWED_PROJECTS` cấu hình thật rồi đọc denial thật. Không phải yêu cầu của guide (là self-claim), nên không chặn nộp; nhưng để đóng theo Quy tắc interface thật, nên có test probe gọi 1 tool AECDM khi allow-list hẹp và khẳng định `denied_allowlist`.

---

## Đối chiếu kỳ vọng known-answer

**KHỚP.** Kỳ vọng spec: dựng được ma trận ~15-20 requirement (đạt: 20 requirement + 9 claim); liệt kê các claim all/every/always/never/only (đạt: C1-C9); **không phát sinh P0/P1 mới** (đạt: 0 ❌ ở cả hai ma trận). Repo được coi là sạch ở v0.1.4 — kết quả pass mong đợi, kèm bằng chứng chạy thật (probe `tools/list` OK, 46 tool, khớp 1:1). Hai commit sau release (webhooks, core-subpath) **không** tạo finding: webhooks tool có mặt trong cả manifest lẫn `tools/list`, cờ mutation đúng, host callback ràng https/allowlist.

Các điểm từng là finding ở vòng review cũ đã xác nhận **đã vá thật** (không tin ghi chú): app_model="A" đúng (không phải "hosted"); mô tả audit định tính đủ 3 giới hạn (fail-open, protocol-layer, include_reads); mô tả tool sạch instruction/sensitive-data.

---

## Đề xuất khóa máy (sync-test / generate — patterns/declaration-sync.md)

1. **Sync-test manifest ↔ server thật (tầng 2 → tầng 1):** biến probe `tools/list` trong audit này thành test CI: assert tên tool + cờ mutation của `tools/list` khớp `mcp-manifest.json` **chính xác**. Đây là lá chắn trực tiếp cho lỗi guide "mismatch manifest ↔ behavior" và sẽ bắt drift ngay khi thêm/sửa tool. (Manifest nên được **generate** từ registry + chú thích, không viết tay.)
2. **Sync-test egress-host ↔ manifest:** test tĩnh assert tập host trong `url-guard`/`APS_BASE_URL`/`GRAPHQL_URL` ⊆ `external_endpoints` của manifest → khóa yêu cầu "no undeclared endpoint" + "HTTPS".
3. **Assert `ai_llm_providers:[]` ↔ deps:** test fail nếu `package.json` xuất hiện dep AI/telemetry mà manifest/PRIVACY vẫn khai "none".
4. **Declaration Form vào repo (F2):** đưa form thành artifact tầng 3 có bản trong repo để audit sau đối chiếu được R19/R20.
5. **Probe allow-list denial (F3):** test integration bật `FORMA_ALLOWED_PROJECTS` hẹp, gọi 1 AECDM tool, assert `denied_allowlist` — đóng C9 bằng interface thật.

---

## Phản hồi về chính lệnh /audit (cho domain MCP-submission)

Lệnh **chạy được nguyên xi** cho domain này; 6 bước ánh xạ sạch. Ghi nhận để cải thiện:

- **Bước 1 (Ingest) thiếu kỹ thuật cho trang JS-app.** WebFetch trả tóm tắt "trang có vẻ thiếu nội dung" vì FAQ/accordion nhúng dạng **JSON escaped trong HTML**, không phải DOM tĩnh; `curl` mặc định trả **0 byte** (cần browser User-Agent). Kỹ thuật đã proven cần thêm vào lệnh: *"trang marketplace/doc dạng SPA → `curl -A <browser-UA>` rồi extract JSON nhúng (regex `title/content/body`, unescape `\\uXXXX` + strip HTML) — đừng tin WebFetch báo 'trang thiếu nội dung'."* Đây đúng là "tài liệu nhắc tài liệu con" mà lệnh đã cảnh báo, chỉ thiếu cách moi.
- **Bước 2/4 nên nêu rõ bucket 📭 cho "artifact bắt buộc nhưng ngoài tầm với".** Guide yêu cầu Declaration Form nhưng nó không ở repo — lệnh hiện chỉ có 4 bucket ✅❌👁📭; 📭 ("không có bằng chứng") đã đủ diễn đạt, nhưng ví dụ trong lệnh nên có 1 case "requirement trỏ tới artifact tay ngoài repo → 📭 + đề xuất kéo vào repo" để reviewer không cố ép thành ✅/❌.
- **Bước 4 Quy tắc interface thật rất hợp domain MCP** — "start server, tools/list qua protocol thật, phân biệt đạt/vi phạm/không-phản-hồi" ánh xạ 1:1 với server MCP. Không cần sửa. Đề xuất nhỏ: bổ sung gợi ý "auth-mode nào cho tools/list rẻ nhất (2lo/dummy cred) và kiểm tra đăng ký tool có phụ thuộc auth-mode không" — vì đó là bẫy tiềm ẩn (may mắn ở đây registration độc lập auth).
- **Bước 3 (claim matrix)** khớp tốt: gắt all/every/always/never/only bắt đúng các overclaim tinh tế (tagline "Audit every action" vs chi tiết định tính). Giữ nguyên.
