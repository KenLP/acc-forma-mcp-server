import { env } from '../config/env.js';
import { getDb } from './db.js';
import type { McpToolResult } from '../tools/_types.js';

export interface IdempotencyStore {
  check(key: string): McpToolResult | null;
  store(key: string, result: McpToolResult, expiresAt: number): void;
}

// ---- Memory backend --------------------------------------------------------

interface MemRecord { result: McpToolResult; expiresAt: number }

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, MemRecord>();

  check(key: string): McpToolResult | null {
    const rec = this.map.get(key);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) { this.map.delete(key); return null; }
    return rec.result;
  }

  store(key: string, result: McpToolResult, expiresAt: number): void {
    this.map.set(key, { result, expiresAt });
  }
}

// ---- SQLite backend --------------------------------------------------------

type IdemRow = { result_json: string; expires_at: number };

class SqliteIdempotencyStore implements IdempotencyStore {
  check(key: string): McpToolResult | null {
    const row = getDb()
      .prepare('SELECT result_json,expires_at FROM idempotency_records WHERE idem_key=?')
      .get(key) as IdemRow | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      getDb().prepare('DELETE FROM idempotency_records WHERE idem_key=?').run(key);
      return null;
    }
    return JSON.parse(row.result_json) as McpToolResult;
  }

  store(key: string, result: McpToolResult, expiresAt: number): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO idempotency_records (idem_key,result_json,expires_at) VALUES (?,?,?)')
      .run(key, JSON.stringify(result), expiresAt);
  }
}

// ---- Factory ---------------------------------------------------------------

let _store: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (!_store) {
    _store = env.FORMA_PERSISTENCE_MODE === 'sqlite'
      ? new SqliteIdempotencyStore()
      : new MemoryIdempotencyStore();
  }
  return _store;
}

export function _resetIdempotencyStore(): void { _store = null; }
