# STUDY: Toàn bộ codebase acc-forma-mcp-server — 2026-07-17

> Ôn lại để **hiểu và nhớ**, không phải tra API. Số liệu trong tài liệu này lấy từ code
> thật tại commit `234fb05` (v0.1.4 + webhooks): **46 tools, 272 tests / 37 files, ~10.9k
> dòng src**. Mọi mục đều trỏ `file:line` — nếu code đổi mà tài liệu chưa đổi, **tin code**.

---

## 1. Phiên bản đơn giản nhất

Nó là **một cái phích cắm giữa AI và dữ liệu công trình**: Claude (hay MCP client bất kỳ)
nói chuyện với Autodesk Construction Cloud/Forma qua 46 "tool" — đọc model, issue, clash,
so sánh phiên bản, tạo issue có pin 3D. Điểm khác biệt so với một API wrapper thường:
**mọi thao tác ghi đều phải xem trước và được duyệt, và mọi thứ đã xảy ra đều được ghi vào
một cuốn sổ không sửa được.**

Một câu để nhớ: *đọc thoải mái, ghi phải xem trước, làm gì cũng có sổ.*

---

## 2. Vấn đề nó giải quyết

Trước khi có nó, muốn hỏi "toà nhà này có bao nhiêu m² sàn theo từng tầng" thì phải: mở
Revit hoặc viết script gọi APS, tự lo OAuth, tự phân trang, tự gom nhóm. Còn muốn AI làm
hộ thì gặp ba nỗi sợ rất thật:

1. **AI đoán bừa payload rồi ghi thẳng vào dữ liệu dự án thật.** LLM hallucinate một
   `issue_subtype_id` không tồn tại, hoặc hiểu sai ý người dùng — và issue đã tạo rồi.
2. **Không ai biết AI đã làm gì.** Cuối tuần phát hiện 30 issue lạ, không truy được ai/khi nào.
3. **Bung phạm vi.** Credential nhìn thấy 300 project, AI chỉ được phép đụng 2 project.

Ba nỗi sợ đó đẻ ra ba trụ cột của codebase: **dry-run + approval token**, **audit hash
chain**, **allow-list**. Toàn bộ thư mục `src/safety/` (10 file) tồn tại vì chúng.

---

## 3. Bức tranh tổng

```
MCP client (Claude Desktop / VS Code)
        │  stdio JSON-RPC
        ▼
┌──────────────────────────────────────────────────────────┐
│ index.ts        khởi động: env → auth → registry → stdio  │
│ server.ts       đăng ký 46 tool vào MCP SDK               │
├──────────────────────────────────────────────────────────┤
│ tools/_wrap.ts  ★ TOÀN BỘ AN TOÀN NẰM Ở ĐÂY               │
│                 auth → allow-list → readonly → rate       │
│                 → business rules → preview → token → exec │
│                 → audit (mọi nhánh)                       │
├──────────────────────────────────────────────────────────┤
│ tools/<domain>/ 46 file, mỗi file 1 tool — CHỈ khai báo   │
│                 input schema + gọi apis/, không tự phòng vệ│
├──────────────────────────────────────────────────────────┤
│ apis/           10 client mỏng bọc REST/GraphQL của APS   │
│ http/client.ts  retry, backoff, 401 refresh, 429 Retry-After│
│ auth/           SSA (JWT bearer) + 2LO (client_credentials)│
└──────────────────────────────────────────────────────────┘
        │                          ▲
        ▼                          │
  developer.api.autodesk.com   safety/ ghi ~/.acc-forma-mcp/audit/*.jsonl
```

**Mỗi khối một dòng:**
- `index.ts` — dựng context (auth + env) rồi cắm vào stdio. Không có logic nghiệp vụ.
- `server.ts` — vòng lặp duy nhất: lấy từng tool trong registry, bọc bằng `_wrap`, đăng ký.
- `_wrap.ts` — **file quan trọng nhất repo**. Tool nào không đi qua đây là tool không an toàn.
- `tools/<domain>/*.ts` — mỗi tool khai `inputSchema` (zod) + `execute()`. Cố tình "ngu":
  không tool nào tự kiểm allow-list hay tự ghi audit.
- `apis/*.ts` — chuyển đổi REST/GraphQL ↔ type TS. Không business logic.
- `core.ts` — cửa hàng bán lẻ: 21 export cho project khác dùng như thư viện (n8n, CDE Pulse).

---

## 4. Khái niệm nền cần nắm

### 4.1. MCP server có phải là một service chạy nền không?

**Không.** Đây là hiểu nhầm phổ biến nhất. Nó là một **process con** do MCP client sinh ra,
nói chuyện qua **stdin/stdout** bằng JSON-RPC. Không port, không HTTP, không daemon.

Bằng chứng trong code: `src/index.ts:92-93` — `new StdioServerTransport()` rồi
`server.connect(transport)`. Hệ quả thực tế: muốn test thật thì phải **spawn process và
ghi JSON vào stdin** (đó chính là cách các probe trong session verify), chứ không curl được.

### 4.2. Tool là gì trong project này?

Một object TS có `name`, `description`, `inputSchema` (zod), `scope`, và `execute()`.
Xem `src/tools/_types.ts:29-80` (`ReadToolDef`) và `:82-120` (`MutationToolDef`).

Điểm cần nhớ: `description` **không phải comment nội bộ** — nó là văn bản LLM đọc để quyết
định gọi tool nào, **và** là artifact Autodesk review khi submit. Nên nó bị soi hai lớp
(xem §7.4).

### 4.3. Dry-run + approval token

**Khái niệm chung:** thao tác nguy hiểm chia hai bước — bước 1 xem trước, bước 2 xác nhận.

**Trong project này:** `dry_run` mặc định `true` (`src/tools/_wrap.ts:16-40`, các field
`MutationBaseFields` được **tiêm tự động** vào schema mọi mutation tool ở `server.ts:30-33`).
Bước 1 trả `approval_token` (ULID, TTL 300s). Bước 2 phải gửi lại token đó.

Token **không phải mật khẩu chung** — nó bị **buộc vào payload** bằng SHA-256:
`src/safety/approval.ts:14-23` lưu `payloadHash`, `:58-65` so lại. Đổi một chữ trong title
sau khi preview → token vô hiệu. Đây là chống "AI xem trước cái A rồi thực thi cái B".

### 4.4. Hash chain — cuốn sổ không sửa được

**Khái niệm chung:** mỗi dòng chứa hash của dòng trước, sửa dòng giữa thì mọi dòng sau sai.

**Trong project này:** `src/safety/hash-chain.ts:4-13`:
```
this_hash = sha256(prev_hash + canonical_json(entry_không_có_this_hash))
```
`canonical` nghĩa là **sort key trước khi stringify** (dòng 6-10) — nếu không, cùng một
object mà thứ tự key khác nhau sẽ ra hash khác nhau.

`verifyChain` (`:21-42`) kiểm **hai** thứ, đây là chi tiết hay quên:
1. `this_hash` có đúng không → bắt **sửa** nội dung
2. `prev_hash` có trỏ đúng dòng trước không → bắt **xoá** dòng

Chỉ kiểm (1) thì xoá nguyên một dòng vẫn "hợp lệ".

### 4.5. Allow-list và `scope` — khái niệm khó nhất repo

**Vấn đề:** allow-list chứa **Data Management id** (`b.<guid>`). Nhưng không phải tool nào
cũng nhận id loại đó. AECDM có id riêng, Model Derivative dùng URN.

**Giải pháp:** mỗi tool **tự khai** mình thuộc loại nào — `src/tools/_types.ts:30-43`:

| `scope` | Nghĩa | `_wrap` làm gì |
|---|---|---|
| `{kind:'dm'}` | input có DM hub/project id | check qua `getHubId`/`getProjectId` |
| `{kind:'discovery'}` | không có input để scope; tự lọc output | không làm gì (tool tự lọc) |
| `{kind:'no-resource'}` | không đụng resource ACC nào (`meta_*`) | không làm gì |
| `{kind:'unmappable', resource}` | id không map được về DM | **từ chối** khi allow-list bật |

Enforce ở `src/tools/_wrap.ts:95-118` (`enforceScope`). Vì `scope` là field **bắt buộc**
(`_types.ts:72`), quên khai = **lỗi biên dịch**, không phải bug âm thầm.

> **Tại sao không tự suy ra từ tên field?** Vì đó chính là bug cũ — xem §7.1.

### 4.6. SSA vs 2LO — hai danh tính, không phải fallback

- **SSA** (Secure Service Account): danh tính "robot" được mời vào project. Thấy đúng
  project được gán. Bắt buộc cho Issues/Reviews/AECDM/MC.
- **2LO** (client_credentials): danh tính "ứng dụng". Thấy **mọi** project trong hub.

`src/index.ts:41-46`: ở mode `ssa`, server tạo **cả hai**. Tool khai `preferredAuth:'2lo'`
(DM/Admin/MD/Docs) dùng 2LO để có tầm nhìn toàn hub.

**Điểm phải nhớ:** đây là **chọn một lần lúc startup theo tool**, KHÔNG phải failover. 2LO
lỗi thì **không** tự thử lại bằng SSA. Manifest từng khai sai chỗ này (§7.5).

---

## 5. Walkthrough — đi theo một lần tạo issue

Kịch bản thật: LLM muốn tạo issue "Thiếu cửa chống cháy" ở project `b.5341a615-...`.

### Lượt 1 — preview

**Input** (LLM gửi qua stdio):
```json
{"method":"tools/call","params":{"name":"issues_create","arguments":{
  "project_id":"b.5341a615-0679-4b74-9166-bf2aaab55418",
  "title":"Thiếu cửa chống cháy","issue_subtype_id":"a1b2..."}}}
```
Chú ý: **không có `dry_run`** → zod điền mặc định `true` (`_wrap.ts:17-23`).

**Đường đi** (`wrapMutationTool`, `src/tools/_wrap.ts:170` trở đi):

| Bước | Dòng | Xảy ra gì |
|---|---|---|
| 0. Auth mode | `:200` | `issues_create` cần `ssa`\|`3lo`. Đang chạy `2lo` → dừng, audit `denied_auth_mode` |
| 1. Allow-list | `:210` | `scope:{kind:'dm'}` → `checkProjectAllowed('b.5341...')` |
| 2. Readonly | `:213` | `FORMA_READONLY=true`? → dừng |
| 3. Rate | `:216` | issues_create ≤ 50/project/giờ |
| 4. Business rules | `:219` | validator cục bộ, **chưa gọi APS** |
| 5. buildPreview | `:226` | **có gọi APS** — lấy danh sách subtype để kiểm `issue_subtype_id` có thật và đang active |
| 6. Vì dry_run | `:230-258` | Dựng preview, **cấp token**, audit `stage:'preview'`, **dừng — không ghi gì lên ACC** |

**Output:** JSON preview (method, URL, body đầy đủ) + `approval_token: "appr_01JX..."`.

Audit ghi gì? Trong file JSONL chỉ có **fingerprint**, không có token sống:
```json
{"stage":"preview","tool":"issues_create","output_summary":{"approval_token_fp":"ae7c28e1c18691be"}}
```
(`_wrap.ts:248-252`). Lý do ở §6.4.

### Lượt 2 — thực thi

LLM gửi lại **y hệt** + `dry_run:false, approval_token:"appr_01JX..."`.

| Bước | Dòng | Xảy ra gì |
|---|---|---|
| 1-5 | | chạy lại **toàn bộ** (allow-list, rate, rules, preview) |
| 6b. Idempotency | `:260-278` | có `idempotency_key`? key cũ + payload cũ → trả cache, audit `idempotent_replay` (**không gọi APS lần 2**); key cũ + payload khác → `denied_idempotency` |
| 7. Token | `:280-306` | không token → `denied_missing_approval`; token sai/hết hạn/payload đổi → `denied_approval` |
| 8. Execute | `:308` | POST thật lên ACC |
| 9. Audit | `:313-320` | `stage:'executed'` |

**Điểm mấu chốt của bước 7:** `verifyAndConsumeToken` (`approval.ts:29-68`) hash lại payload
hiện tại và so với hash lúc preview. Nếu LLM đổi `title` giữa hai lượt → `ApprovalError`.
Token bị **xoá ngay khi dùng** (`:67`) → dùng lại lần hai luôn hỏng.

**Nếu APS trả 500?** `http/client.ts:133` ném `ApsIndeterminateError` → audit
`outcome_unknown`, **không phải** `failed_api`. Vì POST đã bay đi rồi, ACC có thể đã tạo
issue trước khi lỗi — nói "thất bại" là nói sai sự thật cho người đọc log.

---

## 6. Những quyết định thiết kế & TẠI SAO

### 6.1. Toàn bộ an toàn dồn vào một file (`_wrap.ts`), tool cố tình "ngu"
**Chọn:** wrapper lo hết; tool chỉ khai schema + gọi API.
**Loại bỏ:** mỗi tool tự kiểm tra.
**Vì:** 46 tool × 8 lớp bảo vệ = 368 chỗ có thể quên. Một chỗ quên = một lỗ hổng im lặng.
Dồn một chỗ thì thêm tool thứ 47 **tự động** có đủ 8 lớp.

### 6.2. `dry_run` mặc định `true`
**Vì:** an toàn phải là **mặc định**, không phải tuỳ chọn. Ai quên đọc docs vẫn an toàn.
Cái giá: 2 round-trip mỗi lần ghi — chấp nhận được vì ghi dữ liệu công trình vốn hiếm và
hệ trọng (ADR 0003).

### 6.3. `scope` là field bắt buộc thay vì suy ra từ tên field
**Vì:** suy đoán từ tên đã tạo bug thật (§7.1). Khai báo tường minh + kiểu bắt buộc biến
"quên" từ bug runtime thành **lỗi biên dịch**. `tests/unit/tools/registry-scope.spec.ts`
khoá thêm các bất biến mà compiler không diễn đạt được.

### 6.4. Audit chỉ ghi **fingerprint** của token, không ghi token sống
**Vì:** file JSONL đọc được bằng `cat`, mà token còn sống suốt TTL. Ghi token sống =
ai đọc được log trong 5 phút đó có thể **replay** để thực thi mutation. Fingerprint
(`approval.ts:81-83`, sha256 cắt 16 hex) vẫn nối được cặp preview↔executed mà vô hại.

### 6.5. Audit **fail-open** mặc định, có công tắc fail-closed
**Chọn:** ghi log lỗi (đầy đĩa/mất quyền) → log error rồi **vẫn chạy tiếp**.
**Vì:** với đa số người dùng, mất một dòng log ít tệ hơn là hỏng cả workflow. Ai cần chuẩn
kiểm toán thì bật `FORMA_AUDIT_FAIL_CLOSED=true`. Điều quan trọng: **đã khai đúng** trong
manifest/PRIVACY/README — nói "audit mọi thứ" mà thực tế fail-open là nói dối.

### 6.6. `/core` phải **env-free**
`src/core.ts` bán API client cho project khác (n8n, CDE Pulse). Nhưng `config/env.ts`
**throw ngay lúc import** nếu thiếu APS creds. Nếu core chạm tới nó, consumer dùng
credential store riêng sẽ chết ngay khi `import`.
→ Bất biến: **không gì reachable từ `core.ts` được import `config/env.js`**. Auth provider
nhận config tường minh; `http/client.ts` dùng `setDefaultApsRegion()` (gọi từ `index.ts:16`).
Test canh giữ: `tests/unit/core/env-free.spec.ts`.

### 6.7. Webhook callback URL bị kiểm trước khi đăng ký
Webhook là mutation **duy nhất** cấu hình **egress lâu dài**: tạo xong, Autodesk POST dữ
liệu dự án tới URL bên thứ ba mãi mãi, không cần gọi lại từ ta (`callback-url.ts:1-12`).
Nên: bắt buộc https, **từ chối vô điều kiện** loopback/private/link-local
(`:26-47` — gồm cả `169.254.169.254`, địa chỉ metadata của cloud), và có
`FORMA_ALLOWED_CALLBACK_HOSTS`.
Lý do từ chối private IP thú vị: Autodesk **không thể** với tới → hook tạo ra trông khoẻ
nhưng im lặng không bao giờ bắn, 5 lần fail liên tiếp là bị vô hiệu hoá. Chặn sớm biến một
"hook chết âm thầm" thành lỗi giải thích được ngay.

---

## 7. Bẫy & edge case đã trả giá

### 7.1. Allow-list suy ra từ **tên field** — lỗ hổng lớn nhất từng có
Wrapper cũ đọc bất kỳ input nào **tên là** `project_id`/`hub_id`. Hai hậu quả:
- 5 tool AECDM dùng `element_group_id` và các tool MD dùng `urn` → **không hề bị kiểm**.
  Allow-list bật vẫn đọc được mọi model mà credential thấy.
- `aecdm_list_element_groups` có field **tên** `project_id` nhưng chứa **AECDM id** (khác
  namespace với `b.<guid>`) → đem so với DM id → **không bảo vệ gì mà lại từ chối oan**.

Bài học: định danh phải theo **namespace**, không theo **tên biến**.

### 7.2. Verifier tự chế cho "green giả"
Regex kiểm "description có chứa instruction không" báo **0 vi phạm**, trong khi thực tế còn
6 — vì regex bắt `use X to/first` mà bỏ sót `Use hub IDs **with**…`, `**To** add a comment,
use…`. Sau đó phải **đọc bằng mắt cả 46 mô tả qua protocol thật**.
Cùng họ: 193 unit test xanh trong khi **exe announce sai version**; test pass ở local vì có
`.env`, đỏ trên CI vì `config/env.ts` throw khi thiếu creds.
Bài học: **grep/test xanh không phải bằng chứng** — probe interface thật, và tái tạo điều
kiện CI (ẩn `.env`, cold cache, chạy 2 lần).

### 7.3. Im lặng bị đọc thành "pass"
Probe đầu tiên in `ALLOWED!` cho 16 tool — thực ra server **chết ngay lúc khởi động** (sai
đường dẫn PEM) nên không trả lời gì. Probe phải phân biệt **ba** trạng thái: đạt / vi phạm /
**không phản hồi**.

### 7.4. Một sự thật, năm bản sao
Mô tả tool tồn tại ở: runtime, `mcp-manifest.json`, form Airtable, README, template email.
Sửa 3 chỗ, sót 2 — lặp lại **năm vòng** review. Chỉ dừng khi viết
`tests/unit/manifest-sync.spec.ts` (máy kiểm thay người đếm).
Bài học: **tuyên bố nào drift được thì phải bị máy khoá** (generate > sync-test > đánh dấu).

### 7.5. Tin ghi chú thay vì nguồn gốc
- Ghi chú nội bộ viết *"FAQ không định nghĩa A/B/C"* → sống sót 5 vòng. Sự thật: định nghĩa
  nằm **trang 1** FAQ (`Local (A)`), manifest đang khai sai `"Local MCP Server"`.
- Manifest khai 2LO *"with SSA as fallback"* — fallback **chưa từng tồn tại** (§4.6).
Bài học: claim thừa kế **không phải** bằng chứng; verify lại với primary source.

### 7.6. `hookTimeout` ≠ `testTimeout`
`vitest.config.ts` đã nâng `testTimeout` lên 30s cho các suite import module graph lớn,
nhưng suite import trong `beforeAll` bị chặn bởi **`hookTimeout`** (mặc định 10s) → đỏ khi
chạy full suite. Sửa nửa vời một lần nữa.

### 7.7. AECDM không có "Level" — và đó là giới hạn dữ liệu, không phải kém thông minh
Level/Base Constraint/Host là **reference parameter** của Revit (trỏ tới element khác).
AECDM chỉ phơi ra **value parameter**, nên giữ `Base Offset` mà mất `Level`.
→ Muốn nhóm theo tầng phải dùng **Model Derivative** (`md_get_properties` + `group_by`).
Có guardrail runtime chặn LLM đi vào ngõ cụt này: `src/tools/aecdm/_param-guidance.ts`.

### 7.8. Pagination: `totalResults` là tổng **mọi trang**
Khi lọc theo allow-list, có lúc gán `totalResults = số dòng đã lọc của trang này` → với
allow-list mặc định `*`, hub 300 project phân trang 50 báo `totalResults: 50`, client dừng
sớm. Sửa: allow-list tắt thì trả nguyên; bật thì **bỏ hẳn** field + thêm `hasMore`/`nextOffset`.

---

## 8. Câu hỏi tự kiểm

1. MCP server này lắng nghe ở port nào?
2. `dry_run` mặc định là gì, và cơ chế nào bảo đảm mọi mutation tool đều có field đó?
3. Vì sao approval token phải buộc vào **payload hash** thay vì chỉ buộc vào tên tool?
4. `verifyChain` kiểm hai điều kiện — điều kiện thứ hai bắt được loại tấn công nào mà điều
   kiện thứ nhất bỏ lọt?
5. Tool `aecdm_query_elements` có field `element_group_id`. Khi `FORMA_ALLOWED_PROJECTS`
   bị thu hẹp, gọi tool này thì chuyện gì xảy ra, và **tại sao** lại thiết kế như vậy?
6. Manifest từng khai 2LO "with SSA as fallback". Câu đó sai ở chỗ nào — dẫn 2 file:line.
7. Mutation gặp HTTP 500 khi POST. Audit ghi stage gì, và vì sao không phải `failed_api`?
8. Vì sao `src/core.ts` không được phép import `config/env.js`? Chuyện gì xảy ra nếu vi phạm?
9. Muốn tính tổng diện tích sàn theo từng tầng của toà nhà — dùng AECDM hay MD? Vì sao?
10. Bạn thêm tool thứ 47 nhưng quên khai `scope`. Lỗi lộ ra ở đâu — lúc chạy hay lúc build?

---
---

### Đáp án

1. **Không port nào.** Nó là process con giao tiếp qua stdin/stdout (`index.ts:92-93`).
2. Mặc định `true`. `MutationBaseFields` (`_wrap.ts:16-40`) được **tiêm tự động** vào schema
   mọi mutation tool tại `server.ts:30-33` — tool không tự khai, nên không thể quên.
3. Nếu chỉ buộc tên tool, LLM có thể preview payload vô hại rồi thực thi payload khác bằng
   cùng token. Buộc payload hash (`approval.ts:58-65`) làm việc đó bất khả thi.
4. Điều kiện `prev_hash` phải trỏ đúng `this_hash` của dòng trước (`hash-chain.ts:31-34`)
   bắt được **xoá nguyên một dòng** — nếu chỉ kiểm `this_hash` của từng dòng thì file sau
   khi xoá vẫn "hợp lệ".
5. **Bị từ chối** (`scope: unmappable`, `_wrap.ts:107`). Vì `element_group_id` thuộc
   namespace AECDM, không map được về DM id để so với allow-list. Cho qua = phá vỡ lời hứa
   trong manifest; so bừa = từ chối oan mà vẫn không bảo vệ. Từ chối kèm giải thích là lựa
   chọn trung thực duy nhất.
6. Ở mode `ssa`, `index.ts:44` **luôn** gán `auth2lo`, nên nhánh kiểm `ctx.auth2lo` trong
   `_wrap.ts:49` không bao giờ rơi về SSA; và 2LO lỗi cũng không retry sang SSA.
7. `outcome_unknown` (`_wrap.ts` handleError, qua `ApsIndeterminateError` từ
   `http/client.ts:133`). Vì request đã gửi đi — ACC **có thể đã áp dụng** thay đổi rồi mới
   lỗi. Ghi `failed_api` là nói với người đọc log điều ngược với sự thật.
8. Vì `config/env.ts` **throw ngay lúc import** khi thiếu APS creds. Consumer như n8n dùng
   credential store riêng sẽ chết ngay dòng `import`. Test canh: `tests/unit/core/env-free.spec.ts`.
9. **MD** (`md_get_properties` với `group_by`). AECDM không phơi reference parameter nên
   không có Level (§7.7).
10. **Lúc build** — `scope` là field bắt buộc trong `ReadToolDef`/`MutationToolDef`
    (`_types.ts:72,105`), thiếu là lỗi TypeScript. Đây là chủ đích: biến lỗi quên thành lỗi
    biên dịch thay vì lỗ hổng im lặng.
