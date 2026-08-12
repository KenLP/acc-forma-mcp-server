# Phương án xử lý audit 2026-08-12 (remote MCP)

> Trạng thái: **KEN ĐÃ DUYỆT 2026-08-12 — CHƯA THỰC THI.** Ba quyết định đã chốt:
> (1) A1-i — loại webhooks khỏi hosted; (2) A3 — sửa code theo lời hứa (audit chỉ lưu
> summary); (3) **hoãn gửi hồ sơ Autodesk tới khi xong CẢ A, B, C** + re-QA toàn bộ.
> Nguồn: `AUDIT_2026-08-12_remote-mcp.md` (reviewer độc lập, commit `c1dea57`).
> Mọi finding đã được verify lại độc lập bằng 2 agent (đọc code + probe chạy thật, không tin
> probe của reviewer). Kết quả: **13/13 CONFIRMED**, kèm các nuance ghi dưới từng mục —
> vài nuance làm đổi hẳn phương án so với remediation mà audit đề xuất.

## Ma trận verdict (tóm tắt)

| # | Finding | Verdict | Nuance từ verify độc lập |
|---|---|---|---|
| P0-1 | Webhooks remote: auth sai | ✅ (a),(b); (c) partial | Không có gate `requiredAuthModes` nên tool chạy êm bằng SSA (không "chết rõ"); vế cross-tenant chỉ đúng *nếu* thêm 2LO chung — hiện chưa có. Hạ tầng lọc tool theo transport chưa tồn tại, nhưng bản rẻ chỉ vài dòng trong `buildServer` |
| P0-2 | Token không bind wire payload | ✅ cơ chế | **Chỉ 1/9 mutation tool có TOCTOU thật** (`issues_pin_element` re-fetch 3 API sống). 8 tool kia build thuần từ input. Cross-request đã được bảo vệ (verify so hash với preview tính lại); lỗ hổng nằm giữa buildPreview↔execute trong CÙNG một request |
| P1-1 | Audit chain gãy qua nửa đêm UTC | ✅ probe độc lập | Restart trước entry đầu ngày mới thì lại đúng — chỉ process sống xuyên đêm mới gãy |
| P1-2 | Verifier không chứng minh non-deletion | ✅ probe | Cắt entry cuối file → vẫn `valid:true`. Description tool đang hứa chữ "deleted" |
| P1-3 | Audit lưu full structuredContent | ✅ | Mutation lưu nguyên object issue/review; read chỉ lưu `{success}`. redact chỉ lọc secret, không lọc business data. PRIVACY:57-58/69 + SUBMISSION:263 nói "summary only" — lệch thật |
| P1-4 | MP/MC tải hết vào RAM, no timeout | ✅ | `maxElements` áp SAU khi parse toàn bộ; fetch không AbortSignal; máy 256MB |
| P2-1 | Body >100KB → 500 thay vì 413 | ✅ probe | Error object nội bộ có sẵn `statusCode:413`, chỉ chưa map ra. express.json chạy trước auth |
| P2-2 | Prune retention chỉ lúc startup | ✅ | Nuance: Fly auto-stop → restart thường xuyên → gap thực tế nhỏ với traffic thưa; chỉ thành vấn đề khi traffic đủ dày giữ máy sống nhiều tháng |
| P2-3 | Cache giữ creds sau disable | ✅ | KHÔNG phải auth bypass — lookup chặn tenant disabled trước khi chạm cache. Rủi ro thật: creds giải mã nằm trong RAM + request đang bay. Lưu ý: CLI disable chạy ở PROCESS KHÁC (fly ssh) nên "evict cache khi disable" không khả thi trực tiếp |
| P2-4 | Wording subprocessors (AWS) | ✅ (legal) | Việc của Ken/legal, model chỉ đề xuất câu chữ |
| D1 | mp_diff tạo việc server-side | ✅ | Idempotent per version pair (comment trong code xác nhận); "cost" là suy đoán, repo không có tài liệu quota MP |
| D2 | Token consume không atomic (multi-process) | ✅ probe | An toàn tuyệt đối single-process (hàm sync 100%, không await ẩn); chỉ thành vấn đề khi scale ngang |
| D3 | Docs pnpm approve-builds stale | ✅ | `pnpm.onlyBuiltDependencies` đã có trong package.json (thêm có chủ đích); 3 docs chưa gỡ cảnh báo cũ. Chưa test fresh-install |

## NHÓM A — chặn submission (làm trước khi gửi hồ sơ Autodesk)

### A1. Webhooks trong remote mode — **ĐÃ CHỐT: phương án i** (loại khỏi hosted)

| Phương án | Nội dung | Công | Đánh đổi |
|---|---|---|---|
| **A1-i (khuyến nghị)** | Loại 3 tool webhooks khỏi remote: thêm cờ `remoteEnabled?: false` vào tool def, `buildServer` bỏ qua khi `ctx.tenantId !== undefined`; test khoá invariant; manifest đánh dấu 3 tool `availability: self-host only`; prose các docs đổi thành "46 tools (43 on the hosted service)" | ~0.5 buổi | Trung thực nhất với reviewer; khách hosted mất webhooks (chưa ai dùng) |
| A1-ii | Giữ tool, thêm `requiredAuthModes: ['2lo']` cho cả 3 → remote (ssa) bị chặn với lỗi rõ ràng | ~15 phút | Listing quảng cáo 46 tool mà 3 cái luôn báo lỗi với khách hosted — trải nghiệm review xấu |
| A1-iii | Xây hook-ownership registry per-tenant + 2LO có kiểm soát (đề xuất của audit) | nhiều buổi | Đúng dài hạn nhưng quá khổ cho pilot; hoãn thành R4 nếu có nhu cầu thật |
| Kèm mọi phương án | `webhooks_list/create/delete` khai `requiredAuthModes` tường minh (hiện đang thiếu — gap thật) | — | — |

### A2. TOCTOU `issues_pin_element` — sửa hẹp, không redesign wrapper

Audit đề xuất "immutable execution plan" cho toàn hệ — verify cho thấy chỉ cần cho 1 tool:
- Mở rộng chữ ký `MutationToolDef.execute(input, ctx, preview?)` — wrapper truyền preview (đã verify hash) vào; 8 tool kia không dùng tham số mới, không đổi gì.
- `issues_pin_element.execute` dùng thẳng body từ `preview.executePayload` thay vì gọi `resolvePin()` lần hai.
- Test: giả lập state đổi giữa buildPreview và execute (mock resolvePin trả giá trị khác) → body gửi đi phải là bản đã approve.
- Bonus khỏi tính: bớt được 3 API call sống mỗi lần execute pin.
Công: ~0.5-1 buổi.

### A3. Audit lưu full output vs lời hứa "summary" — **ĐÃ CHỐT: sửa CODE theo lời hứa** (không hạ lời hứa theo code)

- `_wrap.ts` mutation path: thay `outputSummary: result.structuredContent` bằng summary rút gọn generic — giữ các khoá định danh/trạng thái (`id`, `displayId`, `status`, `published`, counts…), bỏ body/description/custom attrs. Một hàm `summarizeForAudit(structuredContent)` + test.
- Đồng thời vá 3 câu wording (không phải hạ chuẩn, chỉ nói đúng):
  - PRIVACY: nêu `FORMA_AUDIT_FAIL_CLOSED` default fail-open; audit reads default bật; `client_approval_only` là mode bỏ preview phía server (đã có đoạn "what is not promised" — bổ sung 2 ý này).
  - `meta_verify_audit_chain` description: bỏ chữ "deleted", đổi thành "modified or reordered within the retained log" (gộp với A5).
Công: ~0.5 buổi code + 0.5 buổi docs.

### A4. Audit chain gãy qua nửa đêm UTC

- Key `lastHashByDir` theo **đường dẫn file** (dir+ngày) thay vì dir; mỗi file ngày mới bắt đầu từ genesis — khớp đúng semantics của verifier hiện tại (verify từng file độc lập).
- `loadLastHashFromFile` giữ nguyên (đã đọc theo file hôm nay).
- Regression test fake-clock: 2 entry vắt qua nửa đêm → verify cả 2 file đều pass.
Công: ~0.5 buổi. (Không chọn hướng "cross-file chain" của audit — đổi format verifier + docs, nặng mà không thêm giá trị cho single-file verification hiện có.)

### A5. Narrow claim của verifier (gộp vào A3 docs)

Đổi description + PRIVACY: verifier chứng minh tính toàn vẹn **bên trong** chuỗi còn giữ; không chứng minh truncation-cuối-file/thay-file. External anchor (checkpoint ký, đẩy ra ngoài) → backlog R4, ghi rõ trong SAFETY.md là "planned".

### A6. HTTP: 413 + limit tường minh (+ auth trước parse nếu gọn)

- Error middleware map `err.type === 'entity.too.large'` → 413 JSON-RPC; set `express.json({ limit: '256kb' })` tường minh + ghi vào docs.
- Chuyển parse về route-level sau bước check Bearer (`app.post('/mcp', requireBearer, express.json(), handler)`) nếu không kéo theo xáo trộn test lớn; nếu kéo, chỉ làm 413+limit (phần auth-trước-parse xuống Nhóm B).
- Test: body quá to → 413; body hỏng → 400; sau đó /healthz vẫn 200.
Công: ~0.5 buổi.

**Tổng Nhóm A: ~3-4 buổi ≈ 1-2 phiên multi-agent.** Sau nhóm A: chạy lại QA submission (vì tool-count/manifest/PRIVACY đổi) rồi mới gửi hồ sơ.

## NHÓM B — trước khi mở rộng pilot (không chặn submission)

| # | Việc | Công |
|---|---|---|
| B1 | P1-4: AbortSignal timeout cho fetch MP/MC; cap response-size (reject sớm theo Content-Length + đếm bytes khi đọc); stream NDJSON parse từng dòng, áp `maxElements` NGAY khi đọc | 1-2 buổi |
| B2 | P2-2: `setInterval` prune 24h (unref) + PRIVACY đổi "automatically" → "on every server start and at least daily" | 0.25 buổi |
| B3 | P2-3: quy trình offboard trong HANDOFF/PRIVACY — disable → (in-flight tự hết) → `fly machines restart` để xả cache RAM → xoá row + audit theo policy. Không code (CLI ở process khác, không evict cache server được) | 0.25 buổi docs |
| B4 | D2: atomic consume — SqliteTokenStore `DELETE ... WHERE id=? AND tenant_id=?` rồi check `changes===1` trong transaction cùng verify; memory store giữ nguyên | 0.5 buổi |
| B5 | P2-4: đề xuất thêm câu vào PRIVACY: "Some Autodesk downloads are delivered from AWS S3 pre-signed URLs issued by Autodesk — AWS acts as Autodesk's infrastructure, not as our subprocessor" — **Ken/legal duyệt chữ** | Ken |

## NHÓM C — tài liệu & quyết định phân loại

| # | Việc | Công |
|---|---|---|
| C1 | D1: thêm ghi chú vào manifest + submission doc: `mp_diff_versions` giữ phân loại read, kèm disclosure "creates an idempotent, cached server-side diff computation at Autodesk; does not modify project data" | 0.25 buổi |
| C2 | D3: một lần fresh `pnpm install` (temp clone) xác nhận `onlyBuiltDependencies` hiệu lực → gỡ cảnh báo stale ở README/CLAUDE.md/HANDOFF | 0.25 buổi |
| C3 | Sau nhóm A: cập nhật CHANGELOG/HANDOFF/REVIEW_BRIEF; cảm ơn + phản hồi reviewer (audit chất lượng cao, 13/13 đứng vững) | 0.25 buổi |

## Quyết định đã chốt (Ken, 2026-08-12)

1. ✅ **A1-i** — loại 3 tool webhooks khỏi hosted; prose "46 tools (43 on the hosted service)". (Webhooks = đăng ký nhận thông báo sự kiện từ Autodesk về một callback URL — chưa khách hosted nào dùng.)
2. ✅ **A3 theo khuyến nghị** — sửa code: audit chỉ lưu summary rút gọn (id/status/counts), khớp lời hứa đã in trong PRIVACY/hồ sơ.
3. ✅ **Gate gửi hồ sơ = xong CẢ A + B + C** + re-QA submission package. Không gửi sớm.

## Trình tự thực thi đề xuất (khi Ken ra lệnh chạy)

Pipeline multi-agent như các vòng trước; các gói không giẫm file nhau thì chạy song song:

| Đợt | Gói việc | Song song? |
|---|---|---|
| 1 | **A4** (chain rollover — đụng `audit-log.ts`) ∥ **A6** (HTTP 413 — đụng `transport/http.ts`) ∥ **A1** (webhooks flag — đụng `_types/_registry/server.ts` + manifest) | 3 implementer song song, file rời nhau |
| 2 | **A2** (TOCTOU pin-element — đụng `_wrap.ts` + `pin-element.ts`) ∥ **A3-code** (summarizeForAudit — đụng `_wrap.ts`!) → **gộp làm một gói** vì cùng chạm `_wrap.ts` | 1 implementer |
| 3 | **A3-docs + A5 + C1** (PRIVACY/manifest/description wording) ∥ **B1** (streaming/timeout MP+MC) | 2 song song |
| 4 | **B2 + B3 + B4** (prune interval, offboard docs, atomic consume) ∥ **C2** (fresh-install probe + gỡ docs stale) | 2 song song |
| 5 | **Re-QA toàn gói submission** (như vòng QA 2026-08-12 đã bắt được mojibake) → sửa findings → **C3** (CHANGELOG/HANDOFF/REVIEW_BRIEF) → deploy → commit/push nhánh | tuần tự |

Lưu ý khi thực thi:
- Tool count đổi 46→43 trên hosted: `manifest-sync.spec.ts` sẽ cần dạy về cờ `remoteEnabled` (test hiện so manifest ↔ registry 1:1); mọi chỗ prose ghi "46" phải quét lại (README, listing §5b, site, email template).
- B5 (wording AWS/subprocessor) vẫn chờ chữ duyệt của Ken — không tự ý.
- Sau đợt 5 mới `fly deploy` (giữ nguyên luật: production đang phục vụ pilot).
- P2-4/B5 và mọi thay đổi PRIVACY phải giữ giọng "nói ít đi chứ không nói quá".
