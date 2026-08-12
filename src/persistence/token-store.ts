import { env } from '../config/env.js';
import { getDb } from './db.js';

export interface TokenRecord {
  id: string;
  toolName: string;
  payloadHash: string;
  expiresAt: number;
}

/**
 * `tenantId` isolates tokens per remote tenant — a token created under one tenant is
 * simply not found when looked up under another (see src/safety/approval.ts). Callers in
 * local (stdio) mode always pass '' (ToolContext.tenantId undefined maps to '').
 */
export interface TokenStore {
  set(tenantId: string, record: TokenRecord): void;
  get(tenantId: string, id: string): TokenRecord | undefined;
  delete(tenantId: string, id: string): void;
  /**
   * Atomically remove the record if present, reporting whether THIS call was the one that
   * removed it (`true`) as opposed to finding it already gone (`false`). This is the
   * single-use consumption primitive `verifyAndConsumeToken` uses for its final step — a
   * plain get()-then-delete() pair (what this replaced) has a window between the two calls
   * where a second caller can also observe the row via get() before either side deletes it.
   * Within one Node process that window can't be entered (all of the calling code is
   * synchronous, so nothing else runs between the get() and delete() of a single call), but
   * multiple processes sharing one SQLite file are real concurrency — see
   * SqliteTokenStore#consume. MemoryTokenStore#consume only exists so callers don't have to
   * branch on backend; single-process semantics already made get()+delete() safe.
   */
  consume(tenantId: string, id: string): boolean;
}

// ---- Memory backend --------------------------------------------------------

class MemoryTokenStore implements TokenStore {
  private readonly map = new Map<string, TokenRecord>();

  private key(tenantId: string, id: string): string {
    return `${tenantId}::${id}`;
  }

  set(tenantId: string, r: TokenRecord): void { this.map.set(this.key(tenantId, r.id), r); }
  get(tenantId: string, id: string): TokenRecord | undefined { return this.map.get(this.key(tenantId, id)); }
  delete(tenantId: string, id: string): void { this.map.delete(this.key(tenantId, id)); }

  consume(tenantId: string, id: string): boolean {
    const key = this.key(tenantId, id);
    if (!this.map.has(key)) return false;
    this.map.delete(key);
    return true;
  }

  gc(): void {
    const now = Date.now();
    for (const [key, r] of this.map) if (r.expiresAt < now) this.map.delete(key);
  }
}

// ---- SQLite backend --------------------------------------------------------

type TokenRow = { id: string; tool_name: string; payload_hash: string; expires_at: number };

class SqliteTokenStore implements TokenStore {
  set(tenantId: string, r: TokenRecord): void {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO approval_tokens (tenant_id,id,tool_name,payload_hash,expires_at) VALUES (?,?,?,?,?)',
      )
      .run(tenantId, r.id, r.toolName, r.payloadHash, r.expiresAt);
  }

  get(tenantId: string, id: string): TokenRecord | undefined {
    const row = getDb()
      .prepare('SELECT id,tool_name,payload_hash,expires_at FROM approval_tokens WHERE tenant_id=? AND id=?')
      .get(tenantId, id) as TokenRow | undefined;
    if (!row) return undefined;
    return { id: row.id, toolName: row.tool_name, payloadHash: row.payload_hash, expiresAt: row.expires_at };
  }

  delete(tenantId: string, id: string): void {
    getDb().prepare('DELETE FROM approval_tokens WHERE tenant_id=? AND id=?').run(tenantId, id);
  }

  // A single DELETE is its own implicit transaction in SQLite (no explicit BEGIN needed) and
  // the whole database is single-writer even under WAL, so two processes racing this
  // statement are serialized by SQLite itself: the first to execute deletes the row and gets
  // `changes: 1`; the second finds it already gone and gets `changes: 0`. No RETURNING clause
  // needed — the caller already has the row's data from its own get() earlier and only needs
  // a yes/no on which side won the race.
  consume(tenantId: string, id: string): boolean {
    const result = getDb()
      .prepare('DELETE FROM approval_tokens WHERE tenant_id=? AND id=?')
      .run(tenantId, id);
    return result.changes === 1;
  }
}

// ---- Factory ---------------------------------------------------------------

let _store: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!_store) {
    if (env.FORMA_PERSISTENCE_MODE === 'sqlite') {
      _store = new SqliteTokenStore();
    } else {
      const mem = new MemoryTokenStore();
      setInterval(() => mem.gc(), 60_000).unref();
      _store = mem;
    }
  }
  return _store;
}

export function _resetTokenStore(): void { _store = null; }
