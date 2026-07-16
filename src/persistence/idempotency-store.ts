import { env } from '../config/env.js';
import { getDb } from './db.js';
import type { McpToolResult } from '../tools/_types.js';

/**
 * A cached execution result, bound to the operation that produced it.
 * `toolName` + `payloadHash` are verified on lookup (in safety/idempotency.ts) so a
 * key reused for a DIFFERENT operation is rejected instead of replaying this result.
 */
export interface IdempotencyRecord {
  toolName: string;
  payloadHash: string;
  result: McpToolResult;
}

export interface IdempotencyStore {
  check(key: string): IdempotencyRecord | null;
  store(key: string, record: IdempotencyRecord, expiresAt: number): void;
}

// ---- Memory backend --------------------------------------------------------

interface MemRecord { record: IdempotencyRecord; expiresAt: number }

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, MemRecord>();

  check(key: string): IdempotencyRecord | null {
    const rec = this.map.get(key);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) { this.map.delete(key); return null; }
    return rec.record;
  }

  store(key: string, record: IdempotencyRecord, expiresAt: number): void {
    this.map.set(key, { record, expiresAt });
  }
}

// ---- SQLite backend --------------------------------------------------------

type IdemRow = { tool_name: string; payload_hash: string; result_json: string; expires_at: number };

class SqliteIdempotencyStore implements IdempotencyStore {
  check(key: string): IdempotencyRecord | null {
    const row = getDb()
      .prepare('SELECT tool_name,payload_hash,result_json,expires_at FROM idempotency_records WHERE idem_key=?')
      .get(key) as IdemRow | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      getDb().prepare('DELETE FROM idempotency_records WHERE idem_key=?').run(key);
      return null;
    }
    return {
      toolName: row.tool_name,
      payloadHash: row.payload_hash,
      result: JSON.parse(row.result_json) as McpToolResult,
    };
  }

  store(key: string, record: IdempotencyRecord, expiresAt: number): void {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO idempotency_records (idem_key,tool_name,payload_hash,result_json,expires_at) VALUES (?,?,?,?,?)',
      )
      .run(key, record.toolName, record.payloadHash, JSON.stringify(record.result), expiresAt);
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
