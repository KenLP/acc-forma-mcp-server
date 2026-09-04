# HANDOFF: đổi APS Client ID + SSA robot mới (acc-forma-mcp-server)

- **Từ:** acc-forma-mcp-server → **Đến:** bim-orchestrator
- **Ngày:** 2026-08-27 · **Mức ưu tiên:** vừa · **Trạng thái:** OPEN

## Tóm tắt cho người bận

**Bạn KHÔNG phải sửa `.env` của mình.** Credential tự kế thừa qua `FORMA_MCP_SERVER_CWD`.

Ba việc cần làm (bản đầu chỉ ghi việc 1 — đã bổ sung sau phản hồi 27/08):

1. **Mời robot mới vào project demo** `b.57deb033-…` + product access Docs — nếu không,
   mọi tool ACC trả 403/404.
2. **Verify robot mới PATCH được issue do robot cũ tạo** — không chỉ đọc được (xem DoD).
3. **Nếu dựng máy demo AU LIVE (không có Node):** ghi creds mới vào
   `vendor/forma-mcp/.env` — đường exe cần file đó, bên mình sẽ gửi sẵn khối giá trị.

## Bối cảnh (tại sao cần)

acc-forma-mcp-server sắp đổi sang một APS application mới:

- App APS hiện tại (`ACC-Forma MCP Server`, Client ID `OA1rwbIF…VRAvOqwEO`) sẽ được thay bằng
  app mới đăng ký dưới tài khoản `ken.lephuc`, để tách quyền sở hữu sản phẩm thương mại
  (BIMLynx, đang nộp Autodesk Marketplace) khỏi tài khoản cũ.
- Kèm theo: `APS_CLIENT_SECRET` cũ từng lộ trong một ảnh chụp màn hình → app cũ sẽ bị xoá,
  secret cũ chết theo.
- **SSA (robot) được tạo *dưới* một Client ID** — đổi app nghĩa là robot mới hoàn toàn:
  `SSA_ID`, `SSA_KEY_ID`, và file PEM đều mới.

Robot hiện tại: `LK92ADJLPWDRHW2Z` (hiển thị trong ACC là **ACC-Forma-MCP Ken**).

## Đã verify khoảng trống

Đã đọc trực tiếp cấu hình và code của bim-orchestrator, không suy đoán:

**1. Credential tự kế thừa — không cần sửa `.env` của bim-orchestrator**

`bim-orchestrator/.env`:
```
FORMA_MCP_SERVER_CMD=node
FORMA_MCP_SERVER_ARGS=dist/index.js
FORMA_MCP_SERVER_CWD=D:\AIProjects\acc-forma-mcp-server
```

`src/bim_orchestrator/mcp_clients/forma.py` (`FormaMCPConfig.from_env`) xác nhận ý đồ này:
```python
# We deliberately pass NO APS_* / FORMA_* secrets through. The subprocess
# loads them from its own .env (located at cwd) via `dotenv/config`.
env: dict[str, str] = {}
```

→ Vì `FORMA_MCP_SERVER_CWD` được set, nhánh auto-detect exe bị bỏ qua; orchestrator spawn
`node dist/index.js` với cwd là repo acc-forma, và server nạp `.env` của **repo acc-forma**.
Khi bên mình cập nhật `.env`, bim-orchestrator dùng credential mới ngay lần chạy kế tiếp.

**2. Nhưng robot identity đổi → phải mời lại vào project**

`bim-orchestrator/.env` đang trỏ đúng hub/project mà acc-forma dùng để test:
```
DEMO_HUB_ID=b.5341a615-0679-4b74-9166-bf2aaab55418      # Autodesk APAC TS
DEMO_PROJECT_ID=b.57deb033-4608-46de-ab21-fcb0404de6d3  # Ken - MCP Testing
```
Robot mới là một tài khoản khác hẳn robot cũ. Quyền truy cập project **không** đi theo
Client ID — nó gắn với từng service account. Robot mới chưa phải member của project trên
thì mọi call ACC sẽ hỏng.

**3. Bẫy: KHÔNG được để `FORMA_MCP_SERVER_CWD` trống**

Nếu biến đó rỗng, `from_env()` auto-detect sang `vendor/forma-mcp/forma-mcp.exe` và đặt cwd =
`vendor/forma-mcp/`, nơi exe tự nạp `vendor/forma-mcp/.env`. Đã kiểm: **file đó không tồn tại**
(chỉ có `.env.example`). Kết quả sẽ là server khởi động rồi chết vì thiếu credential — và
triệu chứng trông như "đổi Client ID làm hỏng", trong khi nguyên nhân thật là đổi đường spawn.

```
$ ls vendor/forma-mcp/
.env.example
forma-mcp.exe
forma-mcp.exe.sha256
```

## Yêu cầu chính xác

Chỉ một việc, làm **sau khi** bên mình báo đã đổi xong:

1. Vào ACC → project **Ken - MCP Testing** (`b.57deb033-…`) → **Members**
2. Mời service account mới (bên mình sẽ gửi email/tên robot khi tạo xong)
3. Cấp product access giống robot cũ: **Docs** (+ **Model Coordination** nếu luồng clash cần)
4. Vai trò: tương đương robot cũ

Không cần sửa file nào trong repo bim-orchestrator.

**Bổ sung sau phản hồi 27/08 — bộ giá trị cho máy demo chạy exe.** Khi báo robot mới sẵn
sàng, bên mình gửi kèm một khối `.env` đầy đủ theo format `vendor/forma-mcp/.env.example`
(`APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `SSA_ID`, `SSA_KEY_ID`, `SSA_KEY_PATH` + file PEM),
không chỉ gửi email robot. Máy demo AU LIVE không có Node nên chạy `forma-mcp.exe`, và
đường đó nạp `vendor/forma-mcp/.env` — file phải tạo bằng tay khi dựng máy.

## Repro / dữ liệu mẫu

Kiểm tra nhanh sau khi mời (chạy tại `D:\AIProjects\acc-forma-mcp-server`):

```bash
node -e "require('dotenv').config();console.log('client:',process.env.APS_CLIENT_ID?.slice(0,8),'ssa:',process.env.SSA_ID)"
```
→ phải in ra Client ID **mới** và SSA **mới**.

Rồi chạy đúng đường mà orchestrator dùng:
```bash
npx tsx scripts/probe-issues-filter.ts
```
→ trả về dữ liệu project, không phải 403/404.

Từ phía orchestrator, dùng đúng hai lệnh các bạn đã nêu trong phản hồi:
```bash
python -m bim_orchestrator --hello    # aecdm rooms
python -m bim_orchestrator --check    # một lượt check thật
```
→ không có 403/404 từ tool ACC nào.

## Định nghĩa hoàn thành (DoD)

- [ ] Robot mới xuất hiện trong danh sách Members của project `b.57deb033-…`
- [ ] `aecdm_list_hubs` / `aecdm_list_projects` qua orchestrator trả về hub `Autodesk APAC TS`
- [ ] **Robot mới PATCH được một issue do robot cũ (`LK92ADJLPWDRHW2Z`) tạo** — lấy một
      issue đã closed, mở ra rồi đóng lại; không đụng issue đang dùng thật
- [ ] Một luồng QC thật chạy hết, không có lỗi 403/404 từ tool ACC
- [ ] `FORMA_MCP_SERVER_CWD` vẫn giữ nguyên giá trị `D:\AIProjects\acc-forma-mcp-server`

## Ngoài phạm vi

- **Không** sửa `.env` của bim-orchestrator (credential kế thừa tự động).
- **Không** cần build/fetch lại `forma-mcp.exe` — hợp đồng API không đổi.
  ⚠️ **Sửa sau phản hồi 27/08:** bản đầu viết "đường exe hiện không được dùng" — đúng với
  máy dev, **sai với máy demo**. `docs/PRODUCTION_PACKAGING.md` của orchestrator mô tả
  deploy no-Node, ở đó `forma-mcp.exe` + `vendor/forma-mcp/.env` là đường chạy DUY NHẤT.
  (Ghi nhận: file exe có mtime 2026-08-27 và mới có thêm `.sha256`; bên mình không rõ ai
  cập nhật. Không ảnh hưởng chừng nào `FORMA_MCP_SERVER_CWD` còn được set.)
- **Không** cần đổi tool schema — 43 tool hosted / 46 tool stdio giữ nguyên tên và chữ ký.
  Đợt này chỉ đổi danh tính xác thực, không đổi hợp đồng API.
- Việc xoay `APS_CLIENT_SECRET` ở BIMClaw là handoff riêng (BIMClaw giữ bản sao `.env`
  độc lập, khác với bim-orchestrator).

## Trình tự thực hiện (chốt sau phản hồi 27/08)

App cũ bị **xoá** nghĩa là không có giai đoạn chạy song song — secret cũ chết ngay lúc đó.
Thứ tự bắt buộc:

```
tạo app + robot mới
  → mời robot vào project (Ken, trong ACC UI)
  → verify: PATCH issue cũ + smoke test aecdm_*
  → BIMClaw đổi xong bản sao .env  ← PHẢI XONG TRƯỚC
  → lúc đó mới xoá app APS cũ
```

Hai lý do: (a) đang mùa quay AU — một khoảng trống 403 rơi đúng buổi quay là mất buổi;
(b) BIMClaw là công cụ các session Claude dùng để thao tác ACC (vừa dùng đóng issue
#230/#231 hôm nay) — xoá app cũ trước khi BIMClaw đổi xong là mất khả năng dọn ACC.

## Ba tool mà orchestrator thật sự gọi (grep `src/`, 27/08)

`aecdm_list_hubs`, `aecdm_list_projects`, `aecdm_list_element_groups`, `aecdm_query_elements`,
`aecdm_get_element_properties`, `issues_list`, `issues_get`, `issues_create`, `issues_update`,
`issues_add_comment`, `issues_list_types`, `meta_verify_audit_chain`.

**Không có `dm_*` nào.** Bản đầu của handoff này ghi sai — đã sửa trong DoD.

## Đính chính ngược lại phía orchestrator

Phản hồi ghi *".env.example các bạn thấy cũng không còn trên máy này"*. Kiểm lại thì **nó vẫn
còn**:

```
$ ls -la vendor/forma-mcp/
-rw-r--r--       1274  Jul  3 11:39  .env.example
-rwxr-xr-x   45441067  Aug 27 13:45  forma-mcp.exe
-rw-r--r--         64  Aug 27 14:10  forma-mcp.exe.sha256
```

Tin tốt cho mục ①: dựng máy demo chỉ cần `copy .env.example .env` rồi điền, không phải dựng
template từ đầu.
