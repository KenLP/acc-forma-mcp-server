import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { hourBucket } from '../utils/hour-bucket.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = env.FORMA_DB_PATH;
  const dir = dirname(dbPath);
  // 0o700: state.db holds approval tokens and rate/idempotency records and must
  // not be world-readable. POSIX only — on Windows the dir inherits the parent ACL.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrateSchema(_db);
  logger.info({ dbPath }, 'persistence: SQLite store initialized');
  return _db;
}

function migrateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_tokens (
      tenant_id    TEXT    NOT NULL DEFAULT '',
      id           TEXT    NOT NULL,
      tool_name    TEXT    NOT NULL,
      payload_hash TEXT    NOT NULL,
      expires_at   INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS rate_counters (
      tenant_id    TEXT    NOT NULL DEFAULT '',
      bucket_key   TEXT    NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      hour_bucket  TEXT    NOT NULL,
      PRIMARY KEY (tenant_id, bucket_key)
    );
    CREATE TABLE IF NOT EXISTS idempotency_records (
      tenant_id    TEXT    NOT NULL DEFAULT '',
      idem_key     TEXT    NOT NULL,
      tool_name    TEXT    NOT NULL DEFAULT '',
      payload_hash TEXT    NOT NULL DEFAULT '',
      result_json  TEXT    NOT NULL,
      expires_at   INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, idem_key)
    );
    CREATE TABLE IF NOT EXISTS tenants (
      id                     TEXT    PRIMARY KEY,
      name                   TEXT    NOT NULL,
      robot_email            TEXT    NOT NULL,
      service_account_id     TEXT    NOT NULL,
      key_id                 TEXT    NOT NULL,
      private_key_ciphertext TEXT    NOT NULL,
      bearer_key_hash        TEXT    NOT NULL UNIQUE,
      created_at             TEXT    NOT NULL,
      disabled               INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Order matters: a pre-tenant_id idempotency_records table may ALSO predate the
  // tool_name/payload_hash binding columns, so backfill those first — the tenant_id
  // rebuild below copies whatever columns currently exist.
  migrateLegacyIdempotencyColumns(db);
  migrateTenantIdPrimaryKey(db);
}

// Migrate a pre-binding idempotency_records table (no tool_name/payload_hash columns).
// SQLite has no ADD COLUMN IF NOT EXISTS; probe the schema and add what's missing.
function migrateLegacyIdempotencyColumns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(idempotency_records)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('tool_name') || !names.has('payload_hash')) {
    if (!names.has('tool_name')) {
      db.exec(`ALTER TABLE idempotency_records ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''`);
    }
    if (!names.has('payload_hash')) {
      db.exec(`ALTER TABLE idempotency_records ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''`);
    }
    // Unbound rows can't be verified against an operation — drop them (they are
    // short-TTL caches; losing them only costs a re-execution).
    db.exec(`DELETE FROM idempotency_records WHERE tool_name = ''`);
  }
}

// Pre-multi-tenant tables (single-column PRIMARY KEY, no tenant_id) predate the R1 remote
// work. SQLite cannot ALTER a table's PRIMARY KEY, so an existing table is rebuilt: create
// it under the new (tenant_id, <key>) composite-PK schema, copy every row across with
// tenant_id='' (a local single-tenant row keeps the tenant-less identity it always had —
// see ToolContext.tenantId), then swap it in for the original.
function migrateTenantIdPrimaryKey(db: Database.Database): void {
  rebuildWithTenantId(db, {
    table: 'approval_tokens',
    createSql: `
      CREATE TABLE approval_tokens_migrate (
        tenant_id    TEXT    NOT NULL DEFAULT '',
        id           TEXT    NOT NULL,
        tool_name    TEXT    NOT NULL,
        payload_hash TEXT    NOT NULL,
        expires_at   INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )`,
    columns: ['id', 'tool_name', 'payload_hash', 'expires_at'],
  });
  rebuildWithTenantId(db, {
    table: 'rate_counters',
    createSql: `
      CREATE TABLE rate_counters_migrate (
        tenant_id    TEXT    NOT NULL DEFAULT '',
        bucket_key   TEXT    NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        hour_bucket  TEXT    NOT NULL,
        PRIMARY KEY (tenant_id, bucket_key)
      )`,
    columns: ['bucket_key', 'count', 'hour_bucket'],
  });
  rebuildWithTenantId(db, {
    table: 'idempotency_records',
    createSql: `
      CREATE TABLE idempotency_records_migrate (
        tenant_id    TEXT    NOT NULL DEFAULT '',
        idem_key     TEXT    NOT NULL,
        tool_name    TEXT    NOT NULL DEFAULT '',
        payload_hash TEXT    NOT NULL DEFAULT '',
        result_json  TEXT    NOT NULL,
        expires_at   INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, idem_key)
      )`,
    columns: ['idem_key', 'tool_name', 'payload_hash', 'result_json', 'expires_at'],
  });
}

function rebuildWithTenantId(
  db: Database.Database,
  opts: { table: string; createSql: string; columns: string[] },
): void {
  const cols = db.prepare(`PRAGMA table_info(${opts.table})`).all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table doesn't exist — CREATE TABLE IF NOT EXISTS above already made it fresh
  if (cols.some((c) => c.name === 'tenant_id')) return; // already on the composite-PK schema

  const tmp = `${opts.table}_migrate`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(opts.createSql);
  const colList = opts.columns.join(', ');
  db.exec(`INSERT INTO ${tmp} (tenant_id, ${colList}) SELECT '', ${colList} FROM ${opts.table}`);
  db.exec(`DROP TABLE ${opts.table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${opts.table}`);
}

// Mirrors hourBucket() in src/safety/rate-governance.ts (`${year}-${month}-${day}-${hour}`,
// UTC, 0-based month) — not imported directly to avoid a persistence -> safety -> persistence
// import cycle (rate-governance.ts already imports persistence/rate-store.ts).
/** Delete expired rows from token + idempotency tables. Called once at startup. */
export function cleanupExpiredRows(): void {
  const db = getDb();
  const now = Date.now();
  const ap = db.prepare('DELETE FROM approval_tokens   WHERE expires_at < ?').run(now);
  const id = db.prepare('DELETE FROM idempotency_records WHERE expires_at < ?').run(now);
  // rate_counters has no expires_at — rows are bucketed by hour instead. Only the
  // current hour's bucket is still useful for rate limiting; anything from an
  // earlier bucket is dead weight that would otherwise accumulate forever. This is
  // deliberately not scoped by tenant — a stale hour bucket is stale for every tenant.
  const rate = db
    .prepare('DELETE FROM rate_counters WHERE hour_bucket != ?')
    .run(hourBucket());
  const total = (ap.changes ?? 0) + (id.changes ?? 0) + (rate.changes ?? 0);
  if (total > 0) {
    logger.debug(
      { deleted_tokens: ap.changes, deleted_idem: id.changes, deleted_rate: rate.changes },
      'persistence: cleaned expired rows',
    );
  }
}

/** For testing only. Closes the handle first — leaving it open keeps the file locked. */
export function _resetDb(): void {
  _db?.close();
  _db = null;
}
