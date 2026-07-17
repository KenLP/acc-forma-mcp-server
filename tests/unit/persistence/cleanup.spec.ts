import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercises the real SQLite backend (better-sqlite3), not a stub. Every store had
// expiry except rate_counters, which was never cleaned — the table grew without bound
// and PRIVACY.md's "expired rows are purged at startup" was false for it.
//
// Requires the better-sqlite3 native binding. pnpm 10 skips build scripts by default:
// run `pnpm rebuild better-sqlite3` if this suite reports a missing binding. CI uses
// pnpm 9, which builds it automatically.

let dir: string;
let closeDb: (() => void) | undefined;

function envFor(dbPath: string): Record<string, unknown> {
  return {
    FORMA_PERSISTENCE_MODE: 'sqlite',
    FORMA_DB_PATH: dbPath,
    FORMA_APPROVAL_TOKEN_TTL: 300,
  };
}

describe('cleanupExpiredRows (SQLite)', () => {
  beforeEach(() => {
    vi.resetModules();
    closeDb = undefined;
    dir = mkdtempSync(join(tmpdir(), 'forma-db-'));
  });

  afterEach(() => {
    // Windows keeps the file locked while the handle is open, so close before removing.
    closeDb?.();
    rmSync(dir, { recursive: true, force: true });
  });

  async function load(dbPath: string): Promise<typeof import('../../../src/persistence/db.js')> {
    vi.doMock('../../../src/config/env.js', () => ({ env: envFor(dbPath) }));
    const db = await import('../../../src/persistence/db.js');
    db._resetDb();
    closeDb = () => { db._resetDb(); };
    return db;
  }

  it('drops rate_counter buckets from previous hours and keeps the current one', async () => {
    const dbPath = join(dir, 'state.db');
    const { getDb, cleanupExpiredRows } = await load(dbPath);

    // Same helper the rate store writes with — db.ts and rate-governance.ts now share it,
    // so a format change cannot make the purge silently stop matching live rows.
    const { hourBucket } = await import('../../../src/utils/hour-bucket.js');
    const current = hourBucket();

    const d = getDb();
    d.prepare('INSERT INTO rate_counters (bucket_key,count,hour_bucket) VALUES (?,?,?)').run(
      'issues_create:p1', 3, current,
    );
    d.prepare('INSERT INTO rate_counters (bucket_key,count,hour_bucket) VALUES (?,?,?)').run(
      'issues_create:p2', 9, '2020-0-1-0', // long-stale bucket
    );

    cleanupExpiredRows();

    const rows = d.prepare('SELECT bucket_key,hour_bucket FROM rate_counters').all() as Array<{
      bucket_key: string;
      hour_bucket: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bucket_key).toBe('issues_create:p1');
    expect(rows[0]?.hour_bucket).toBe(current);
  });

  it('drops expired approval tokens and idempotency records, keeping live ones', async () => {
    const dbPath = join(dir, 'state.db');
    const { getDb, cleanupExpiredRows } = await load(dbPath);
    const d = getDb();
    const past = Date.now() - 1000;
    const future = Date.now() + 600_000;

    d.prepare(
      'INSERT INTO approval_tokens (id,tool_name,payload_hash,expires_at) VALUES (?,?,?,?)',
    ).run('appr_stale', 'issues_create', 'h', past);
    d.prepare(
      'INSERT INTO approval_tokens (id,tool_name,payload_hash,expires_at) VALUES (?,?,?,?)',
    ).run('appr_live', 'issues_create', 'h', future);
    d.prepare(
      'INSERT INTO idempotency_records (idem_key,tool_name,payload_hash,result_json,expires_at) VALUES (?,?,?,?,?)',
    ).run('k_stale', 'issues_create', 'h', '{}', past);
    d.prepare(
      'INSERT INTO idempotency_records (idem_key,tool_name,payload_hash,result_json,expires_at) VALUES (?,?,?,?,?)',
    ).run('k_live', 'issues_create', 'h', '{}', future);

    cleanupExpiredRows();

    const tokens = d.prepare('SELECT id FROM approval_tokens').all() as Array<{ id: string }>;
    const idem = d.prepare('SELECT idem_key FROM idempotency_records').all() as Array<{
      idem_key: string;
    }>;
    expect(tokens.map((t) => t.id)).toEqual(['appr_live']);
    expect(idem.map((i) => i.idem_key)).toEqual(['k_live']);
  });
});
