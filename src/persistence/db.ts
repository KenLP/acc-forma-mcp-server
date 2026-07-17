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
      id           TEXT    PRIMARY KEY,
      tool_name    TEXT    NOT NULL,
      payload_hash TEXT    NOT NULL,
      expires_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_counters (
      bucket_key   TEXT    PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      hour_bucket  TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency_records (
      idem_key     TEXT    PRIMARY KEY,
      tool_name    TEXT    NOT NULL DEFAULT '',
      payload_hash TEXT    NOT NULL DEFAULT '',
      result_json  TEXT    NOT NULL,
      expires_at   INTEGER NOT NULL
    );
  `);

  // Migrate a pre-binding idempotency_records table (no tool_name/payload_hash columns).
  // SQLite has no ADD COLUMN IF NOT EXISTS; probe the schema and add what's missing.
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
  // earlier bucket is dead weight that would otherwise accumulate forever.
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
