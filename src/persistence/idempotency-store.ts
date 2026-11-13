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
  /**
   * `null` while the operation is in flight: the key was reserved before execute() and the
   * result is not stored yet. Also left `null` when the outcome is unknown (the APS call got
   * no answer), so a retry with the same key is refused instead of running a second time.
   */
  result: McpToolResult | null;
}

/**
 * `tenantId` isolates records per remote tenant (undefined = local mode, stored as
 * tenant ''), same pattern as TokenStore.
 */
export interface IdempotencyStore {
  check(tenantId: string, key: string): IdempotencyRecord | null;
  store(tenantId: string, key: string, record: IdempotencyRecord, expiresAt: number): void;
  /**
   * Atomically claims `key` for an in-flight operation. Returns `null` when this caller now
   * holds the key, or the record already there (completed or in flight) — never both.
   */
  reserve(tenantId: string, key: string, op: { toolName: string; payloadHash: string }, expiresAt: number): IdempotencyRecord | null;
  /** Drops a reservation whose operation did not reach Autodesk, so the key can be retried. */
  release(tenantId: string, key: string): void;
}

// ---- Memory backend --------------------------------------------------------

interface MemRecord { record: IdempotencyRecord; expiresAt: number }

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, MemRecord>();

  private key(tenantId: string, key: string): string {
    return `${tenantId}::${key}`;
  }

  check(tenantId: string, key: string): IdempotencyRecord | null {
    const mapKey = this.key(tenantId, key);
    const rec = this.map.get(mapKey);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) { this.map.delete(mapKey); return null; }
    return rec.record;
  }

  store(tenantId: string, key: string, record: IdempotencyRecord, expiresAt: number): void {
    this.map.set(this.key(tenantId, key), { record, expiresAt });
  }

  // Synchronous check-and-set: no await between the lookup and the claim, so two calls in
  // one process cannot both see the key as free.
  reserve(tenantId: string, key: string, op: { toolName: string; payloadHash: string }, expiresAt: number): IdempotencyRecord | null {
    const existing = this.check(tenantId, key);
    if (existing) return existing;
    this.map.set(this.key(tenantId, key), { record: { ...op, result: null }, expiresAt });
    return null;
  }

  release(tenantId: string, key: string): void {
    this.map.delete(this.key(tenantId, key));
  }
}

// ---- SQLite backend --------------------------------------------------------

type IdemRow = { tool_name: string; payload_hash: string; result_json: string; expires_at: number };

class SqliteIdempotencyStore implements IdempotencyStore {
  check(tenantId: string, key: string): IdempotencyRecord | null {
    const row = getDb()
      .prepare(
        'SELECT tool_name,payload_hash,result_json,expires_at FROM idempotency_records WHERE tenant_id=? AND idem_key=?',
      )
      .get(tenantId, key) as IdemRow | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      getDb().prepare('DELETE FROM idempotency_records WHERE tenant_id=? AND idem_key=?').run(tenantId, key);
      return null;
    }
    return {
      toolName: row.tool_name,
      payloadHash: row.payload_hash,
      result: row.result_json === IN_FLIGHT ? null : (JSON.parse(row.result_json) as McpToolResult),
    };
  }

  store(tenantId: string, key: string, record: IdempotencyRecord, expiresAt: number): void {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO idempotency_records (tenant_id,idem_key,tool_name,payload_hash,result_json,expires_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        tenantId,
        key,
        record.toolName,
        record.payloadHash,
        record.result === null ? IN_FLIGHT : JSON.stringify(record.result),
        expiresAt,
      );
  }

  // INSERT OR IGNORE on the (tenant_id, idem_key) primary key is the atomic claim: across
  // processes sharing state.db exactly one insert changes a row.
  reserve(tenantId: string, key: string, op: { toolName: string; payloadHash: string }, expiresAt: number): IdempotencyRecord | null {
    const db = getDb();
    db.prepare('DELETE FROM idempotency_records WHERE tenant_id=? AND idem_key=? AND expires_at < ?').run(tenantId, key, Date.now());
    const claimed = db
      .prepare(
        'INSERT OR IGNORE INTO idempotency_records (tenant_id,idem_key,tool_name,payload_hash,result_json,expires_at) VALUES (?,?,?,?,?,?)',
      )
      .run(tenantId, key, op.toolName, op.payloadHash, IN_FLIGHT, expiresAt);
    if (claimed.changes === 1) return null;
    return this.check(tenantId, key);
  }

  release(tenantId: string, key: string): void {
    getDb().prepare('DELETE FROM idempotency_records WHERE tenant_id=? AND idem_key=?').run(tenantId, key);
  }
}

/** result_json of a reserved, not yet completed operation (the column is NOT NULL). */
const IN_FLIGHT = '';

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
