import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Exercises the real SQLite backend (better-sqlite3), not a stub — see
// tests/unit/persistence/cleanup.spec.ts for the same rationale. This suite locks the
// migration that rebuilds a PRE-tenant_id local db (single-column PRIMARY KEY, as shipped
// before R1 remote) into the new composite (tenant_id, <key>) schema in place, since SQLite
// cannot ALTER a table's PRIMARY KEY.

let dir: string;
let closeDb: (() => void) | undefined;

function envFor(dbPath: string): Record<string, unknown> {
  return {
    FORMA_PERSISTENCE_MODE: 'sqlite',
    FORMA_DB_PATH: dbPath,
    FORMA_APPROVAL_TOKEN_TTL: 300,
  };
}

describe('db.ts — tenant_id migration of a pre-existing local db', () => {
  beforeEach(() => {
    vi.resetModules();
    closeDb = undefined;
    dir = mkdtempSync(join(tmpdir(), 'forma-migrate-'));
  });

  afterEach(() => {
    closeDb?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds legacy single-column-PK tables in place, keeping every row under tenant_id=\'\'', async () => {
    const dbPath = join(dir, 'state.db');

    // 1. Hand-build the OLD (pre-R1) schema and seed one row per table, exactly as a
    // real local install would have on disk before this upgrade.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE approval_tokens (
        id           TEXT    PRIMARY KEY,
        tool_name    TEXT    NOT NULL,
        payload_hash TEXT    NOT NULL,
        expires_at   INTEGER NOT NULL
      );
      CREATE TABLE rate_counters (
        bucket_key   TEXT    PRIMARY KEY,
        count        INTEGER NOT NULL DEFAULT 0,
        hour_bucket  TEXT    NOT NULL
      );
      CREATE TABLE idempotency_records (
        idem_key     TEXT    PRIMARY KEY,
        tool_name    TEXT    NOT NULL DEFAULT '',
        payload_hash TEXT    NOT NULL DEFAULT '',
        result_json  TEXT    NOT NULL,
        expires_at   INTEGER NOT NULL
      );
    `);
    const futureExpiry = Date.now() + 600_000;
    legacy
      .prepare('INSERT INTO approval_tokens VALUES (?,?,?,?)')
      .run('appr_old1', 'issues_create', 'hash1', futureExpiry);
    legacy
      .prepare('INSERT INTO rate_counters VALUES (?,?,?)')
      .run('issues_create::p1::2024-1-1-0', 5, '2024-1-1-0');
    legacy
      .prepare('INSERT INTO idempotency_records VALUES (?,?,?,?,?)')
      .run('k1', 'issues_create', 'hash1', '{"content":[]}', futureExpiry);
    legacy.close();

    // 2. Open the SAME file through the real module — migrateSchema() runs inside getDb().
    vi.doMock('../../../src/config/env.js', () => ({ env: envFor(dbPath) }));
    const db = await import('../../../src/persistence/db.js');
    db._resetDb();
    closeDb = () => { db._resetDb(); };
    const conn = db.getDb();

    // 3. Every table now has tenant_id as part of a composite PRIMARY KEY...
    const pkCols = (table: string): string[] =>
      (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    expect(pkCols('approval_tokens')).toEqual(['tenant_id', 'id']);
    expect(pkCols('rate_counters')).toEqual(['tenant_id', 'bucket_key']);
    expect(pkCols('idempotency_records')).toEqual(['tenant_id', 'idem_key']);

    // ...and every pre-existing row survived the rebuild under tenant_id=''.
    const token = conn.prepare('SELECT * FROM approval_tokens WHERE id=?').get('appr_old1') as
      | { tenant_id: string; tool_name: string; payload_hash: string; expires_at: number }
      | undefined;
    expect(token).toMatchObject({ tenant_id: '', tool_name: 'issues_create', payload_hash: 'hash1' });

    const rate = conn.prepare('SELECT * FROM rate_counters WHERE bucket_key=?').get(
      'issues_create::p1::2024-1-1-0',
    ) as { tenant_id: string; count: number } | undefined;
    expect(rate).toMatchObject({ tenant_id: '', count: 5 });

    const idem = conn.prepare('SELECT * FROM idempotency_records WHERE idem_key=?').get('k1') as
      | { tenant_id: string; tool_name: string }
      | undefined;
    expect(idem).toMatchObject({ tenant_id: '', tool_name: 'issues_create' });

    // 4. The composite PK actually isolates tenants: the SAME natural key can now exist
    // for a second tenant without colliding — a PK violation under the old schema.
    expect(() =>
      conn
        .prepare('INSERT INTO approval_tokens (tenant_id,id,tool_name,payload_hash,expires_at) VALUES (?,?,?,?,?)')
        .run('tenant-b', 'appr_old1', 'issues_create', 'hash-b', futureExpiry),
    ).not.toThrow();
    const bothTenants = conn.prepare('SELECT tenant_id FROM approval_tokens WHERE id=?').all('appr_old1');
    expect(bothTenants).toHaveLength(2);
  });

  it('is a no-op (does not touch data) when re-opened against an already-migrated db', async () => {
    const dbPath = join(dir, 'state.db');

    vi.doMock('../../../src/config/env.js', () => ({ env: envFor(dbPath) }));
    const first = await import('../../../src/persistence/db.js');
    const firstConn = first.getDb();
    firstConn
      .prepare('INSERT INTO approval_tokens (tenant_id,id,tool_name,payload_hash,expires_at) VALUES (?,?,?,?,?)')
      .run('tenant-a', 'appr_1', 'issues_create', 'h', Date.now() + 600_000);
    first._resetDb();

    // Simulate a process restart: fresh module, same on-disk (already-migrated) file.
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({ env: envFor(dbPath) }));
    const second = await import('../../../src/persistence/db.js');
    closeDb = () => { second._resetDb(); };
    const secondConn = second.getDb();

    const row = secondConn.prepare('SELECT * FROM approval_tokens WHERE id=?').get('appr_1') as
      | { tenant_id: string }
      | undefined;
    expect(row?.tenant_id).toBe('tenant-a'); // row from the first open survived the second migration pass untouched
  });
});
