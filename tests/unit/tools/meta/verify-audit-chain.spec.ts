import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { metaVerifyAuditChainTool } from '../../../../src/tools/meta/verify-audit-chain.js';
import type { ToolContext } from '../../../../src/tools/_types.js';

const TODAY = new Date().toISOString().slice(0, 10);

function makeCtx(auditDir: string): ToolContext {
  return {
    auth: { getAccessToken: () => Promise.resolve('tok'), getScopes: () => [] },
    env: { FORMA_AUDIT_DIR: auditDir } as unknown as ToolContext['env'],
  };
}

describe('meta_verify_audit_chain — malformed JSON detection (R2-2)', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const d = join(tmpdir(), `acc-forma-test-${randomUUID()}`);
    mkdirSync(d, { recursive: true });
    tmpDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore cleanup */ }
    }
  });

  it('returns valid:false with reason malformed_json when a line is not valid JSON', async () => {
    const auditDir = makeTmpDir();
    const validEntry = {
      ts: '2026-06-11T00:00:00.000Z',
      id: 'evt_001',
      tool: 'dm_list_hubs',
      kind: 'read',
      stage: 'executed',
      actor: { auth_mode: 'ssa', ssa_id: null, user_email: null },
      input_redacted: {},
      output_summary: {},
      prev_hash: 'sha256:genesis',
      this_hash: 'sha256:abc',
    };
    writeFileSync(
      join(auditDir, `audit-${TODAY}.jsonl`),
      JSON.stringify(validEntry) + '\nNOT_VALID_JSON\n',
      'utf-8',
    );

    const result = await metaVerifyAuditChainTool.execute({ date: TODAY }, makeCtx(auditDir));

    expect(result.structuredContent).toMatchObject({
      valid: false,
      reason: 'malformed_json',
      firstInvalidIndex: 1,
    });
    expect(result.content[0]!.text).toContain('malformed JSON');
  });

  it('reports the correct line index when the first line is malformed', async () => {
    const auditDir = makeTmpDir();
    writeFileSync(
      join(auditDir, `audit-${TODAY}.jsonl`),
      '{bad json}\n',
      'utf-8',
    );

    const result = await metaVerifyAuditChainTool.execute({ date: TODAY }, makeCtx(auditDir));

    expect(result.structuredContent).toMatchObject({
      valid: false,
      reason: 'malformed_json',
      firstInvalidIndex: 0,
    });
  });

  it('returns valid:null when no audit file exists for the date', async () => {
    const auditDir = makeTmpDir();

    const result = await metaVerifyAuditChainTool.execute({ date: TODAY }, makeCtx(auditDir));

    expect(result.structuredContent).toMatchObject({ valid: null, entryCount: 0 });
  });

  it('returns valid:true with entryCount:0 for an empty file', async () => {
    const auditDir = makeTmpDir();
    writeFileSync(join(auditDir, `audit-${TODAY}.jsonl`), '', 'utf-8');

    const result = await metaVerifyAuditChainTool.execute({ date: TODAY }, makeCtx(auditDir));

    expect(result.structuredContent).toMatchObject({ valid: true, entryCount: 0 });
  });
});
