import { env } from '../config/env.js';
import { getDb } from './db.js';

export interface TokenRecord {
  id: string;
  toolName: string;
  payloadHash: string;
  expiresAt: number;
}

export interface TokenStore {
  set(record: TokenRecord): void;
  get(id: string): TokenRecord | undefined;
  delete(id: string): void;
}

// ---- Memory backend --------------------------------------------------------

class MemoryTokenStore implements TokenStore {
  private readonly map = new Map<string, TokenRecord>();
  set(r: TokenRecord): void { this.map.set(r.id, r); }
  get(id: string): TokenRecord | undefined { return this.map.get(id); }
  delete(id: string): void { this.map.delete(id); }

  gc(): void {
    const now = Date.now();
    for (const [id, r] of this.map) if (r.expiresAt < now) this.map.delete(id);
  }
}

// ---- SQLite backend --------------------------------------------------------

type TokenRow = { id: string; tool_name: string; payload_hash: string; expires_at: number };

class SqliteTokenStore implements TokenStore {
  set(r: TokenRecord): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO approval_tokens (id,tool_name,payload_hash,expires_at) VALUES (?,?,?,?)')
      .run(r.id, r.toolName, r.payloadHash, r.expiresAt);
  }

  get(id: string): TokenRecord | undefined {
    const row = getDb()
      .prepare('SELECT id,tool_name,payload_hash,expires_at FROM approval_tokens WHERE id=?')
      .get(id) as TokenRow | undefined;
    if (!row) return undefined;
    return { id: row.id, toolName: row.tool_name, payloadHash: row.payload_hash, expiresAt: row.expires_at };
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM approval_tokens WHERE id=?').run(id);
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
