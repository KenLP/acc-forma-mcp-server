import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = env.FORMA_DB_PATH;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

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
      result_json  TEXT    NOT NULL,
      expires_at   INTEGER NOT NULL
    );
  `);
}

/** Delete expired rows from token + idempotency tables. Called once at startup. */
export function cleanupExpiredRows(): void {
  const db = getDb();
  const now = Date.now();
  const ap = db.prepare('DELETE FROM approval_tokens   WHERE expires_at < ?').run(now);
  const id = db.prepare('DELETE FROM idempotency_records WHERE expires_at < ?').run(now);
  const total = (ap.changes ?? 0) + (id.changes ?? 0);
  if (total > 0) {
    logger.debug(
      { deleted_tokens: ap.changes, deleted_idem: id.changes },
      'persistence: cleaned expired rows',
    );
  }
}

/** For testing only */
export function _resetDb(): void {
  _db = null;
}
