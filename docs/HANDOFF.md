# HANDOFF — acc-forma-mcp-server

## Việc dở dang

- [ ] **`better-sqlite3` native binding không build** (có sẵn từ trước, không phải regression). `pnpm install` mặc định bỏ qua postinstall script — in cảnh báo `Ignored build scripts: better-sqlite3, esbuild`. Hệ quả: user làm đúng theo README/CI rồi bật `FORMA_PERSISTENCE_MODE=sqlite` sẽ **crash `Could not locate bindings file`** thay vì tạo được `state.db` như `PRIVACY.md` mô tả. Cần `pnpm approve-builds` (hoặc tài liệu hoá bước này trong README/docs/AUTH.md). Phát hiện bởi QA 2026-07-16.
- [ ] **Không có unit test cho SQLite backend** (có sẵn từ trước). `src/persistence/db.ts`, `SqliteTokenStore`, `SqliteRateStore`, `SqliteIdempotencyStore` chưa có test nào — chỉ đường memory-mode được phủ. Chặn được bằng test sau khi giải quyết mục trên.

## Việc thủ công chờ Ken (không giao cho model)

- [ ] Gửi email nộp marketplace (`appsubmissions@autodesk.com`) — nội dung sẵn ở `docs/MCP-PUBLISHER-SUBMISSION.md` §5; chốt danh tính gửi (cá nhân Gmail vs email Autodesk — xem cảnh báo §14.1 Publisher Agreement).
- [ ] (Tuỳ chọn) Thêm 5 secrets vào GitHub environment `integration` để integration tests chạy live trên CI.
- [ ] (Backlog) Publish npm package `acc-forma-mcp-server`; test SEA exe với SQLite binding.

## Đã xong

- [x] **`docs/specs/SPEC_review-remediation-2.md`** — thực thi 2026-07-16. Toàn bộ 6 finding của `REVIEW_FINDINGS_2026-07-16.md` đã đóng: #1/#2/#3 ở commit `db86911`, #4/#5/#6 + follow-ons ở đợt này. 178/178 test pass (verify 2 lần cold cache). Chi tiết trong CHANGELOG mục `[Unreleased]`.
