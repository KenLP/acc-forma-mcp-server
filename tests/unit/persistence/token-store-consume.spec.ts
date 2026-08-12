import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercises the real SQLite backend (better-sqlite3), not a stub — same rationale as
// tests/unit/persistence/cleanup.spec.ts. B4 (audit remediation, 2026-08-12): the plain
// get()-then-delete() pair `verifyAndConsumeToken` used to do for single-use consumption has
// a window, real only across processes sharing one SQLite file, where two callers both read
// a still-present token before either deletes it. TokenStore#consume replaces that with one
// conditional DELETE — this file proves the second of two consume() calls for the same
// (tenantId, id) loses (returns false / changes 0), which is what stops the second caller
// from executing the mutation.

let dir: string;
let closeDb: (() => void) | undefined;

function envFor(dbPath: string): Record<string, unknown> {
  return {
    FORMA_PERSISTENCE_MODE: 'sqlite',
    FORMA_DB_PATH: dbPath,
    FORMA_APPROVAL_TOKEN_TTL: 300,
  };
}

describe('SqliteTokenStore#consume (atomic single-use)', () => {
  beforeEach(() => {
    vi.resetModules();
    closeDb = undefined;
    dir = mkdtempSync(join(tmpdir(), 'forma-token-consume-'));
  });

  afterEach(() => {
    // Windows keeps the file locked while the handle is open, so close before removing.
    closeDb?.();
    rmSync(dir, { recursive: true, force: true });
  });

  async function load(
    dbPath: string,
  ): Promise<{
    tokenStore: typeof import('../../../src/persistence/token-store.js');
    db: typeof import('../../../src/persistence/db.js');
  }> {
    vi.doMock('../../../src/config/env.js', () => ({ env: envFor(dbPath) }));
    const db = await import('../../../src/persistence/db.js');
    const tokenStore = await import('../../../src/persistence/token-store.js');
    db._resetDb();
    tokenStore._resetTokenStore();
    closeDb = () => {
      tokenStore._resetTokenStore();
      db._resetDb();
    };
    return { tokenStore, db };
  }

  it('a second consume() of the same token loses the race (changes: 0)', async () => {
    const dbPath = join(dir, 'state.db');
    const { tokenStore } = await load(dbPath);
    const store = tokenStore.getTokenStore();

    store.set('', {
      id: 'appr_race',
      toolName: 'issues_create',
      payloadHash: 'h',
      expiresAt: Date.now() + 60_000,
    });

    const first = store.consume('', 'appr_race');
    const second = store.consume('', 'appr_race');

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('consume() of a token that never existed returns false', async () => {
    const dbPath = join(dir, 'state.db');
    const { tokenStore } = await load(dbPath);
    const store = tokenStore.getTokenStore();

    expect(store.consume('', 'appr_never_existed')).toBe(false);
  });

  it('consume() is tenant-scoped — a token under tenant A is not consumable under tenant B', async () => {
    const dbPath = join(dir, 'state.db');
    const { tokenStore } = await load(dbPath);
    const store = tokenStore.getTokenStore();

    store.set('tenant-a', {
      id: 'appr_tenant',
      toolName: 'issues_create',
      payloadHash: 'h',
      expiresAt: Date.now() + 60_000,
    });

    expect(store.consume('tenant-b', 'appr_tenant')).toBe(false);
    expect(store.consume('tenant-a', 'appr_tenant')).toBe(true);
  });

  it('verifyAndConsumeToken (end-to-end, sqlite-backed) still rejects double-consumption', async () => {
    const dbPath = join(dir, 'state.db');
    vi.doMock('../../../src/config/env.js', () => ({ env: envFor(dbPath) }));
    const db = await import('../../../src/persistence/db.js');
    const tokenStore = await import('../../../src/persistence/token-store.js');
    db._resetDb();
    tokenStore._resetTokenStore();
    closeDb = () => {
      tokenStore._resetTokenStore();
      db._resetDb();
    };

    const approval = await import('../../../src/safety/approval.js');
    const ENV = { FORMA_APPROVAL_TOKEN_TTL: 300 } as unknown as import('../../../src/config/env.js').Env;

    const payload = { body: 'race' };
    const token = approval.createApprovalToken('issues_create', payload, ENV);

    // First call goes through the new consume()-based final step and succeeds.
    expect(() => approval.verifyAndConsumeToken(token, 'issues_create', payload, ENV)).not.toThrow();
    // A second call with the same token now fails at the not-found check — the row is gone,
    // same observable behavior as before this change (just now via a real DELETE...changes
    // check instead of a bare delete()), confirming the swap didn't alter the public contract.
    expect(() => approval.verifyAndConsumeToken(token, 'issues_create', payload, ENV)).toThrow(
      approval.ApprovalError,
    );
  });
});
