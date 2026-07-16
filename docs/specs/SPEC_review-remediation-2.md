# SPEC: Remediation đợt 2 — review findings #4/#5/#6 + follow-ons

- **Ngày:** 2026-07-16 · **Trạng thái:** READY (chưa thực thi)
- **Người thực thi dự kiến:** session mới, KHÔNG có ngữ cảnh hội thoại này
- **Nguồn:** `REVIEW_FINDINGS_2026-07-16.md`. Findings #1 (token trong audit), #2 (dependency vulns), #3 (idempotency binding) **đã fix ở commit `db86911`** — KHÔNG đụng lại.

## Bài toán & mục tiêu

Sau đợt fix bảo mật `db86911`, còn 3 finding chính (#4 manifest khai sai mode, #5 privacy thiếu SQLite, #6 OAuth scope thừa) và 5 follow-on cơ khí. Xong = tất cả các edit dưới đây được áp đúng nguyên văn, `npm run typecheck && npm run lint && npm run build && npm run test` xanh (hiện 168 test, sau spec này ≥ 174), và `pnpm install --frozen-lockfile` vẫn pass.

**Quy ước chung:** commit message trung dung (nêu thay đổi, không kể lý do dài dòng), KHÔNG có dòng `Co-Authored-By`. Mỗi Task một commit theo tên cho sẵn. `pnpm-lock.yaml` không được đổi (không Task nào thêm/bớt dependency).

## Quyết định thiết kế (đã chốt — không mở lại)

| # | Quyết định | Lý do | Phương án đã loại |
|---|---|---|---|
| D1 | **GIỮ** mode `client_approval_only`, sửa mọi tuyên bố thành "default mode requires..." + khai rõ mode trong manifest | Mode hợp lệ cho orchestrator tin cậy; Autodesk chỉ cấm *mismatch*, không cấm mode | Xoá mode (regression tính năng, quyết định sản phẩm không thuộc phạm vi review-fix) |
| D2 | PRIVACY.md mô tả cả 2 backend (memory mặc định + sqlite opt-in), nêu rõ `state.db` chứa gì | Khai đúng mọi cấu hình, không chỉ default | Chỉ mô tả default (vẫn là khai thiếu — đúng lỗi #5) |
| D3 | Bỏ hẳn `account:write`; `data:write` chỉ xin khi server KHÔNG readonly | Admin tools hiện chỉ đọc; minimum privilege | Giữ "để dành cho tương lai" (trái nguyên tắc, đúng lỗi #6) |
| D4 | URL guard: MP URLs phải đúng host `developer.api.autodesk.com` (trước khi gắn bearer); MC resource URLs phải https + host kết thúc `.amazonaws.com` | Chặn leak bearer/SSRF nếu API response bị thao túng | Regex trên chuỗi URL (dễ bypass — dùng `new URL()` parse) |
| D5 | Rate limit mặc định phủ đủ 7/7 mutation: update=100, add_comment=100, pin_element=50, md_trigger_translation=20 (per project per hour) | Hồ sơ khai "per-tool rate governance" như control chung | Chỉ sửa câu chữ hồ sơ thành "3 tools" (yếu hơn, control có sẵn cơ chế config) |
| D6 | package.json thêm `files` allow-list + script `prepack` | `pnpm pack` hiện đóng gói cả src/tests/prototypes/docs nội bộ | `.npmignore` (dễ trôi — allow-list an toàn hơn deny-list) |
| D7 | Thêm unit test cho `wrapMutationTool` (file mới, fake tool, mock env+audit) | Review chỉ ra wrapper chưa có test nào; đây là nơi chứa toàn bộ safety | Sửa integration test (cần creds thật, không chạy được local/CI) |

## Hiện trạng liên quan (đã khảo sát 2026-07-16, sau `db86911`)

- `src/index.ts:33-39` — cả `TwoLeggedAuthProvider` và `SsaAuthProvider` xin `['data:read', 'data:write', 'account:read', 'account:write']`.
- `src/safety/readonly-mode.ts:15` — readonly khi `env.FORMA_READONLY || env.FORMA_MUTATION_MODE === 'readonly'`.
- `src/tools/_wrap.ts:17-24` — `MutationBaseFields.dry_run` describe có câu *"Set FORMA_MUTATION_MODE=client_approval_only in env to skip the two-step flow."*
- `mcp-manifest.json` → `security_controls` phần tử [0] = `"Dry-run preview required before any mutating tool executes"`, [1] = `"Explicit approval token required to confirm and apply a mutating action"`, [4] = `"Per-tool rate governance"`.
- `src/apis/model-properties.ts:101-103` — `fetchNdjson()` gắn bearer vào `url` nhận từ API response, không validate.
- `src/apis/model-coordination.ts:216` — `await fetch(r.url)` với URL S3 từ API response, không validate.
- `src/safety/rate-governance.ts:12-16` — `DEFAULT_RATE_CONFIG` chỉ có `issues_create:50`, `reviews_create:20`, `reviews_transition:50`.
- `docs/SAFETY.md:109-111` — mục "DM SDK: no automatic retry" đã SAI: `src/apis/data-management.ts:18-55` có retry/backoff (`callSdk`).
- `package.json` — KHÔNG có trường `files`, không có `prepack`.
- `PRIVACY.md` §1.4 (dòng ~78-81) nói token/counter "in memory only"; §3 bảng retention; thực tế `src/persistence/db.ts` tạo `~/.acc-forma-mcp/state.db` (WAL) với 3 bảng `approval_tokens` (id=token sống!, tool_name, payload_hash, expires_at), `rate_counters`, `idempotency_records` (idem_key, tool_name, payload_hash, result_json — **result_json chứa business data**, expires_at) khi `FORMA_PERSISTENCE_MODE=sqlite` (default `memory`, env.ts:61). Cleanup: `cleanupExpiredRows()` chạy lúc startup, xoá row hết hạn (TTL = `FORMA_APPROVAL_TOKEN_TTL`, default kiểm tra trong env.ts).
- `README.md:236+` mục "Safety Guardrails"; dòng 4 và bảng dòng 22 nói dry-run cho mọi write; mục "## Privacy" (trước "## License") nói audit log là thứ duy nhất ghi disk.
- `docs/MCP-PUBLISHER-SUBMISSION.md` §4 các ô "Data retention policy" / "Where data is stored" / "Data deletion process" — cùng khẳng định in-memory-only.
- Test hiện có: `tests/unit/safety/*.spec.ts` mock env bằng `vi.mock('../../../src/config/env.js', () => ({ env: {...} }))` TRƯỚC import (xem `approval.spec.ts:1-20` làm mẫu). 168 test đang pass.

**Invariant phải giữ:** ENV-FREE core (không file nào reachable từ `src/core.ts` được import `config/env.js` — guard test `tests/unit/core/env-free.spec.ts`). LƯU Ý: `model-properties.ts` và `model-coordination.ts` nằm TRONG core → util URL guard mới KHÔNG được import env/logger-có-env. Đặt nó ở `src/utils/url-guard.ts` thuần, không import gì ngoài Node built-ins.

## Spec chi tiết

### Task 1 — Scope minimization (finding #6)

**File: `src/index.ts`.** Thay block dòng ~28-40:

```ts
  // Minimum privilege: account:write is never requested (Admin tools are read-only),
  // and data:write is only requested when the server can actually write.
  const writesEnabled = !(env.FORMA_READONLY || env.FORMA_MUTATION_MODE === 'readonly');
  const scopes = ['data:read', 'account:read', ...(writesEnabled ? ['data:write'] : [])];

  // 2-legged provider is always created alongside SSA so DM/Admin tools can use
  // hub-wide project visibility (SSA only sees projects the account is assigned to).
  const twoLegged = new TwoLeggedAuthProvider(scopes);
```
và trong `case 'ssa':` → `auth = new SsaAuthProvider(scopes);`. Nếu có nhánh `case '2lo'` dùng scope literal thì cũng thay bằng `scopes`. Không đổi gì khác trong file.

**Commit:** `fix(auth): request minimum OAuth scopes — drop account:write, gate data:write on write mode`

### Task 2 — Đồng bộ tuyên bố mode (finding #4, D1)

1. **`src/tools/_wrap.ts`** — trong `MutationBaseFields.dry_run.describe(...)` XÓA nguyên câu `'Set FORMA_MUTATION_MODE=client_approval_only in env to skip the two-step flow.'` (giữ phần còn lại nguyên văn, dọn khoảng trắng thừa).
2. **`mcp-manifest.json`** — thay toàn bộ mảng `security_controls` bằng:
```json
  "security_controls": [
    "Two-step mutation flow (default FORMA_MUTATION_MODE=preview_required): a dry-run preview plus a payload-bound, single-use approval token are required before any mutating tool executes",
    "Operator-configurable mutation modes, disclosed here: preview_required (default, two-step), client_approval_only (the operator's MCP client is trusted to approve; the two-step token flow is skipped), readonly (all mutations disabled)",
    "Project/hub allow-list restricting which resources the server may touch",
    "Read-only mode toggle to globally disable all mutating tools",
    "Per-tool, per-project hourly rate limits covering every mutating tool (defaults built in; overridable via FORMA_RATE_CONFIG_PATH)",
    "SHA-256 hash-chained local audit log of all tool calls, independently verifiable via meta_verify_audit_chain; approval tokens are stored only as fingerprints"
  ]
```
3. **`README.md`** — cuối mục `### 1. Dry-run by default` (sau câu "To execute, re-call the same tool with `dry_run=false, approval_token=<token>`."), thêm đoạn:
```markdown

> The two-step flow is the **default** (`FORMA_MUTATION_MODE=preview_required`). Operators may opt into `client_approval_only` (skips the token round-trip when the MCP client itself gates approvals) or `readonly` (blocks every write). See [Configuration](#configuration).
```

**Commit:** `docs(safety): state mutation-mode behavior consistently across manifest, README and tool schema`

### Task 3 — Privacy/hồ sơ khai SQLite (finding #5, D2)

1. **`PRIVACY.md`** — thay nguyên mục `### 1.4 In-memory state` (3 dòng hiện tại) bằng:
```markdown
### 1.4 Approval tokens, rate counters, idempotency records

By default (`FORMA_PERSISTENCE_MODE=memory`) approval tokens, rate-limit counters, and
idempotency records are held **in memory only** and are discarded when the process exits.

If you opt into `FORMA_PERSISTENCE_MODE=sqlite`, the same data is instead stored in a
local SQLite database on your machine (default `~/.acc-forma-mcp/state.db`, configurable
via `FORMA_DB_PATH`) so that restarts do not invalidate in-flight approvals:

| Table | Contents |
|---|---|
| `approval_tokens` | live approval token ids, the tool name, a SHA-256 payload hash, expiry |
| `rate_counters` | per-tool/per-project hourly counters |
| `idempotency_records` | idempotency keys, tool name, payload hash, and the **cached tool result** — which can include Autodesk project/business data returned by that call |

Rows expire with the approval-token TTL and are purged at startup. Like the audit log,
`state.db` never leaves your machine — treat it with the same care as project data.
```
2. **`PRIVACY.md`** — trong bảng §3 "Data retention and deletion", thay row `| Approval tokens, rate counters | Not retained. In memory only; discarded on exit. |` bằng:
```markdown
| Approval tokens, rate counters, idempotency records | Memory mode (default): discarded on exit. SQLite mode: stored in `state.db` on your machine until the approval-token TTL expires; expired rows are purged at startup. |
```
3. **`PRIVACY.md`** — §4, trong bullet "**Delete all stored data:**" thay `delete the audit directory (~/.acc-forma-mcp/audit, or your FORMA_AUDIT_DIR) and unset the environment variables` bằng `delete the audit directory (~/.acc-forma-mcp/audit, or your FORMA_AUDIT_DIR), delete state.db if you enabled SQLite persistence (~/.acc-forma-mcp/state.db, or your FORMA_DB_PATH), and unset the environment variables`.
4. **`README.md`** mục `## Privacy` — thay câu `the only thing written to disk is a local audit log on your own machine (90-day default retention)` bằng `the only things written to disk are a local audit log on your own machine (90-day default retention) and — only if you enable SQLite persistence — a local state.db for approval tokens/rate counters/idempotency records`.
5. **`docs/MCP-PUBLISHER-SUBMISSION.md`** — trong 3 khối "Data retention policy" / "Where data is stored" / "Data deletion process": bổ sung câu tương ứng về `state.db` (optional SQLite mode, path mặc định `~/.acc-forma-mcp/state.db`, chứa approval tokens + rate counters + idempotency records kể cả cached results, expired rows purged at startup, xoá file = xoá sạch). Giữ văn phong tiếng Anh sẵn có.

**Commit:** `docs(privacy): disclose optional SQLite persistence (state.db) in policy, README and submission pack`

### Task 4 — URL guard cho dynamic URLs (follow-on a, D4)

1. **File MỚI `src/utils/url-guard.ts`** (thuần, KHÔNG import env/logger — nằm trong import-graph của core):
```ts
/** Error thrown when a server-provided URL is outside the declared endpoint set. */
export class DisallowedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Refusing to fetch "${url}": ${reason}`);
    this.name = 'DisallowedUrlError';
  }
}

export interface UrlPolicy {
  /** Exact hostnames allowed (e.g. 'developer.api.autodesk.com'). */
  exactHosts?: string[];
  /** Hostname suffixes allowed (e.g. '.amazonaws.com'). Matched with endsWith. */
  hostSuffixes?: string[];
}

/**
 * Validate a URL received from an API response before fetching it (and especially
 * before attaching a bearer token). HTTPS is always required. Throws DisallowedUrlError.
 */
export function assertAllowedUrl(rawUrl: string, policy: UrlPolicy): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DisallowedUrlError(rawUrl, 'not a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new DisallowedUrlError(rawUrl, `protocol must be https, got "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  const exactOk = (policy.exactHosts ?? []).some((h) => host === h.toLowerCase());
  const suffixOk = (policy.hostSuffixes ?? []).some((s) => host.endsWith(s.toLowerCase()));
  if (!exactOk && !suffixOk) {
    throw new DisallowedUrlError(rawUrl, `host "${host}" is not in the declared endpoint set`);
  }
  return parsed;
}
```
2. **`src/apis/model-properties.ts`** — đầu file thêm `import { assertAllowedUrl } from '../utils/url-guard.js';`. Trong `fetchNdjson`, TRƯỚC dòng `const token = await auth.getAccessToken();` thêm:
```ts
  // Bearer goes only to the declared APS host — never to an arbitrary URL from a response.
  assertAllowedUrl(url, { exactHosts: ['developer.api.autodesk.com'] });
```
3. **`src/apis/model-coordination.ts`** — import như trên. Ngay TRƯỚC `const dl = await fetch(r.url);` (dòng ~216) thêm:
```ts
      assertAllowedUrl(r.url, { hostSuffixes: ['.amazonaws.com'] });
```
4. **`src/core.ts`** — thêm `export { assertAllowedUrl, DisallowedUrlError, type UrlPolicy } from './utils/url-guard.js';` vào khu Utils.
5. **Test MỚI `tests/unit/utils/url-guard.spec.ts`** — không cần mock env (module thuần). Cases bắt buộc: (a) đúng exact host → trả URL; (b) host lạ → throw DisallowedUrlError; (c) `http:` → throw; (d) suffix `.amazonaws.com` pass với `bucket.s3.us-east-1.amazonaws.com`; (e) host `evil-amazonaws.com` (không có dấu chấm trước suffix) → PHẢI throw — suffix bắt đầu bằng `.` nên endsWith an toàn, test để chốt; (f) chuỗi không phải URL → throw.

**Commit:** `fix(security): validate server-provided URLs against declared endpoints before fetching`

### Task 5 — Rate limit phủ đủ mutation (follow-on b, D5)

**`src/safety/rate-governance.ts`** — thay `DEFAULT_RATE_CONFIG` bằng:
```ts
const DEFAULT_RATE_CONFIG: RateConfig = {
  'issues_create': { per_project_per_hour: 50 },
  'issues_update': { per_project_per_hour: 100 },
  'issues_add_comment': { per_project_per_hour: 100 },
  'issues_pin_element': { per_project_per_hour: 50 },
  'reviews_create': { per_project_per_hour: 20 },
  'reviews_transition': { per_project_per_hour: 50 },
  'md_trigger_translation': { per_project_per_hour: 20 },
};
```
Nếu `tests/unit/safety/rate-governance.spec.ts` tồn tại và assert số tool trong default config thì cập nhật assertion theo 7 tool.

**Commit:** `fix(safety): default rate limits cover all 7 mutation tools`

### Task 6 — SAFETY.md hết stale (follow-on e)

**`docs/SAFETY.md`** — thay nguyên mục (heading + đoạn văn) `### DM SDK: no automatic retry` bằng:
```markdown
### DM SDK: same retry behavior as the rest

The Data Management adapter (`src/apis/data-management.ts`) wraps APS SDK calls in
`callSdk()`, which applies the same exponential-backoff retry (with jitter) and
401 token-invalidation as `apsRequest()` in `src/http/client.ts`. Errors that
exhaust retries surface as `ApsApiError`.
```

**Commit:** `docs(safety): DM SDK retry description matches implementation`

### Task 7 — Packaging allow-list (follow-on h, D6)

**`package.json`** — thêm 2 trường (giữ nguyên phần còn lại):
- `"files": ["dist", "README.md", "LICENSE", "PRIVACY.md", "mcp-manifest.json"]` (README/LICENSE luôn được npm tự kèm, liệt kê tường minh cho rõ).
- Trong `scripts`: `"prepack": "npm run build"`.

Tự kiểm: `npm pack --dry-run 2>&1 | tail -30` — danh sách file KHÔNG được chứa `src/`, `tests/`, `prototypes/`, `docs/`, `scripts/`, `.github/`.

**Commit:** `chore(pack): restrict published package contents to dist + metadata`

### Task 8 — Unit test cho wrapMutationTool (follow-on d, D7)

**File MỚI `tests/unit/tools/wrap-mutation.spec.ts`** — dùng nguyên khung sau (đã tính đúng thứ tự mock; chỉnh nhỏ nếu type lệch):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock env BEFORE importing anything that reads it at load time.
vi.mock('../../../src/config/env.js', () => ({
  env: {
    APS_AUTH_MODE: 'ssa',
    SSA_ID: 'test-ssa',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_PERSISTENCE_MODE: 'memory',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_AUDIT_FAIL_CLOSED: false,
    FORMA_AUDIT_RETENTION_DAYS: 90,
  },
}));

// Capture audit entries instead of writing files.
const auditEntries: unknown[] = [];
vi.mock('../../../src/safety/audit-log.js', () => ({
  appendAuditEntry: (p: unknown) => { auditEntries.push(p); },
  AuditPersistenceError: class extends Error {},
}));

const { wrapMutationTool } = await import('../../../src/tools/_wrap.js');
import type { MutationToolDef, ToolContext } from '../../../src/tools/_types.js';

const inputSchema = z.object({ project_id: z.string(), title: z.string() });

function makeTool(executeSpy: ReturnType<typeof vi.fn>): MutationToolDef<typeof inputSchema> {
  return {
    name: 'test_mutation',
    title: 'Test',
    description: 'test',
    kind: 'mutation',
    scopes: ['data:write'],
    inputSchema,
    getProjectId: (i) => i.project_id,
    buildPreview: async (i) => ({
      method: 'POST', url: 'https://developer.api.autodesk.com/x',
      body: { title: i.title }, sideEffects: [], businessRulesPassed: [],
      executePayload: { title: i.title },
    }),
    execute: executeSpy as never,
  } as MutationToolDef<typeof inputSchema>;
}

const ctx = { auth: {}, env: { APS_AUTH_MODE: 'ssa' } } as unknown as ToolContext;
const BASE = { project_id: 'p1', title: 'hello' };

describe('wrapMutationTool safety pipeline', () => {
  beforeEach(() => { auditEntries.length = 0; });

  it('dry_run returns approval token; audit contains only its fingerprint', async () => {
    const exec = vi.fn();
    const handler = wrapMutationTool(makeTool(exec), ctx);
    const res = await handler({ ...BASE, dry_run: true });
    const token = (res.structuredContent as Record<string, unknown>)['approval_token'] as string;
    expect(token).toMatch(/^appr_/);
    expect(exec).not.toHaveBeenCalled();
    const auditJson = JSON.stringify(auditEntries);
    expect(auditJson).not.toContain(token);                 // live token never audited
    expect(auditJson).toContain('approval_token_fp');       // fingerprint is
  });

  it('execute without token is rejected', async () => {
    const exec = vi.fn();
    const handler = wrapMutationTool(makeTool(exec), ctx);
    const res = await handler({ ...BASE, dry_run: false });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('approval_token is required');
    expect(exec).not.toHaveBeenCalled();
  });

  it('preview → execute with the issued token succeeds exactly once', async () => {
    const exec = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const handler = wrapMutationTool(makeTool(exec), ctx);
    const prev = await handler({ ...BASE, dry_run: true });
    const token = (prev.structuredContent as Record<string, unknown>)['approval_token'] as string;
    const res = await handler({ ...BASE, dry_run: false, approval_token: token });
    expect(res.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);
    // token is single-use
    const again = await handler({ ...BASE, dry_run: false, approval_token: token });
    expect(again.isError).toBe(true);
  });

  it('idempotency_key reused for a different payload is rejected', async () => {
    const exec = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const handler = wrapMutationTool(makeTool(exec), ctx);
    const p1 = await handler({ ...BASE, dry_run: true });
    const t1 = (p1.structuredContent as Record<string, unknown>)['approval_token'] as string;
    await handler({ ...BASE, dry_run: false, approval_token: t1, idempotency_key: 'K1' });
    const p2 = await handler({ ...BASE, title: 'DIFFERENT', dry_run: true });
    const t2 = (p2.structuredContent as Record<string, unknown>)['approval_token'] as string;
    const res = await handler({ ...BASE, title: 'DIFFERENT', dry_run: false, approval_token: t2, idempotency_key: 'K1' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('different operation');
  });
});
```
LƯU Ý cho implementer: nếu `MutationPreviewResult` (src/tools/_types.ts) có field khác tên (vd `sideEffects` vs `side_effects`) thì đọc `_types.ts` và chỉnh `buildPreview` mock cho khớp type — KHÔNG đổi test assertions. Nếu structuredContent của dry-run đặt token ở key khác, xem `buildDryRunPreview` trong `src/safety/dry-run.ts` để lấy đúng key.

**Commit:** `test(wrap): cover mutation pipeline — token issue/consume, fingerprint-only audit, idempotency binding`

## Kế hoạch bước cho implementer

1. Task 1 → chạy `npm run typecheck && npm run test` → commit.
2. Task 2 (3 file) → `npm run lint` + `node -e "JSON.parse(require('fs').readFileSync('mcp-manifest.json','utf8'))"` → commit.
3. Task 3 (3 file docs) → đọc lại diff bằng `git diff` xem markdown không vỡ bảng → commit.
4. Task 4 (guard + 2 call site + core export + test) → `npm run test` (env-free guard test PHẢI vẫn xanh) → commit.
5. Task 5 → `npm run test` → commit.
6. Task 6 → commit.
7. Task 7 → `npm pack --dry-run` kiểm danh sách → commit (xoá file .tgz nếu lỡ tạo).
8. Task 8 → `npm run test` toàn bộ → commit.
9. Cuối cùng: `npm run typecheck && npm run lint && npm run build && npm run test` + `pnpm install --frozen-lockfile` → push tất cả (`git push origin main`) → xác nhận CI xanh bằng `gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status`.

## Tiêu chí nghiệm thu

- [ ] `grep -rn "account:write" src/` → 0 kết quả.
- [ ] `grep -rn "client_approval_only in env to skip" src/` → 0 kết quả.
- [ ] Manifest: `security_controls` có 6 phần tử, phần tử [1] chứa "disclosed here".
- [ ] `grep -n "state.db" PRIVACY.md README.md docs/MCP-PUBLISHER-SUBMISSION.md` → có kết quả ở CẢ 3 file.
- [ ] `tests/unit/utils/url-guard.spec.ts` ≥ 6 cases pass; `evil-amazonaws.com` bị chặn.
- [ ] `DEFAULT_RATE_CONFIG` có đúng 7 keys.
- [ ] `docs/SAFETY.md` không còn chuỗi "does not retry".
- [ ] `npm pack --dry-run` không liệt kê `src/`, `tests/`, `prototypes/`.
- [ ] Toàn bộ suite ≥ 174 tests pass; env-free guard pass; CI xanh sau push.

## Không làm (ngoài phạm vi)

- KHÔNG publish npm package (cần tài khoản npm của Ken — việc thủ công).
- KHÔNG đụng SEA/exe pipeline hay checksum release asset.
- KHÔNG viết lại integration tests sang wrapper-mode (Task 8 là thay thế unit-level).
- KHÔNG xoá/đổi mode `client_approval_only` (D1 đã chốt GIỮ + disclose).
- KHÔNG đổi version, KHÔNG re-tag, KHÔNG sửa GitHub Release.
- KHÔNG thêm/bớt dependency (pnpm-lock.yaml phải giữ nguyên).
