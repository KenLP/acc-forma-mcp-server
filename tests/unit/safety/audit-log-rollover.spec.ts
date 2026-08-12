import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyChain } from '../../../src/safety/hash-chain.js';
import type { ChainEntry } from '../../../src/safety/hash-chain.js';
import type { Env } from '../../../src/config/env.js';

// Silence pino output so test runs don't emit JSON lines to stderr.
vi.mock('../../../src/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

/**
 * Regression for the UTC-midnight audit-chain rollover bug (AUDIT_2026-08-12 A4 / P1-1):
 * a long-lived process caching lastHash *per directory* would carry yesterday's hash into
 * today's file, so today's first entry got prev_hash = yesterday's this_hash instead of
 * genesis — and verifyChain (which checks one file at a time) reported it invalid. This test
 * uses fake timers to cross UTC midnight WITHOUT resetting the module, so it exercises the
 * same long-lived in-memory cache a real Fly.io process would carry, and writes to a real
 * temp directory (not a mocked fs) so the two audit-YYYY-MM-DD.jsonl files are read back for
 * real, exactly as `meta_verify_audit_chain` would.
 */
describe('audit-log: UTC-midnight file rollover (real fs, fake clock, no module reset)', () => {
  let auditDir: string;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'acc-forma-audit-rollover-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(auditDir, { recursive: true, force: true });
  });

  it('starts the new day file from genesis and both days verify independently', async () => {
    const { appendAuditEntry } = await import('../../../src/safety/audit-log.js');

    const env = {
      APS_AUTH_MODE: 'ssa',
      SSA_ID: 'test-ssa',
      APS_REGION: 'US',
      FORMA_AUDIT_DIR: auditDir,
      FORMA_AUDIT_INCLUDE_READS: true,
      FORMA_AUDIT_FAIL_CLOSED: false,
      FORMA_AUDIT_INDEX: 'none',
      FORMA_AUDIT_RETENTION_DAYS: 90,
      FORMA_ALLOWED_HUBS: '*',
      FORMA_ALLOWED_PROJECTS: '*',
      FORMA_MUTATION_MODE: 'preview_required',
      FORMA_READONLY: false,
      FORMA_APPROVAL_TOKEN_TTL: 300,
    } as unknown as Env;

    // Day 1: two entries, just before UTC midnight — same process, same in-memory cache.
    vi.setSystemTime(new Date('2026-08-12T23:58:00Z'));
    appendAuditEntry({ tool: 'day1.a', kind: 'read', stage: 'executed', inputRedacted: {}, outputSummary: {} }, env);
    appendAuditEntry({ tool: 'day1.b', kind: 'read', stage: 'executed', inputRedacted: {}, outputSummary: {} }, env);

    // Cross UTC midnight without reloading the module — the bug only reproduces when the
    // in-memory cache survives the rollover.
    vi.setSystemTime(new Date('2026-08-13T00:02:00Z'));
    appendAuditEntry({ tool: 'day2.a', kind: 'read', stage: 'executed', inputRedacted: {}, outputSummary: {} }, env);
    appendAuditEntry({ tool: 'day2.b', kind: 'read', stage: 'executed', inputRedacted: {}, outputSummary: {} }, env);

    const day1File = join(auditDir, 'audit-2026-08-12.jsonl');
    const day2File = join(auditDir, 'audit-2026-08-13.jsonl');

    const day1Entries = readFileSync(day1File, 'utf-8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as ChainEntry);
    const day2Entries = readFileSync(day2File, 'utf-8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as ChainEntry);

    expect(day1Entries).toHaveLength(2);
    expect(day2Entries).toHaveLength(2);

    // The bug: day2's first entry would inherit day1's last this_hash instead of genesis.
    expect(day1Entries[0]!.prev_hash).toBe('sha256:genesis');
    expect(day2Entries[0]!.prev_hash).toBe('sha256:genesis');

    expect(verifyChain(day1Entries)).toEqual({ valid: true });
    expect(verifyChain(day2Entries)).toEqual({ valid: true });
  });
});
