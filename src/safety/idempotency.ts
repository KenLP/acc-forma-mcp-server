import { env } from '../config/env.js';
import type { McpToolResult } from '../tools/_types.js';

interface IdempotencyRecord {
  result: McpToolResult;
  expiresAt: number;
}

// In-memory store keyed by client-supplied idempotency_key.
// LIMITATION: lost on restart, not shared across processes.
// Will be migrated to the durable store when FORMA_PERSISTENCE_MODE=sqlite is implemented.
const store = new Map<string, IdempotencyRecord>();

/**
 * Return the cached result for this key if it exists and has not expired.
 * Returns null if the key is unknown or stale.
 */
export function checkIdempotency(key: string): McpToolResult | null {
  const rec = store.get(key);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return rec.result;
}

/**
 * Cache the result under key for FORMA_APPROVAL_TOKEN_TTL seconds.
 * Re-uses the same TTL as approval tokens since both expire after the same
 * "operation window" — if a token expires, its associated idempotency record
 * is no longer useful either.
 */
export function storeIdempotencyResult(key: string, result: McpToolResult): void {
  store.set(key, {
    result,
    expiresAt: Date.now() + env.FORMA_APPROVAL_TOKEN_TTL * 1000,
  });
}

// GC expired records every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of store) {
    if (rec.expiresAt < now) store.delete(key);
  }
}, 60_000).unref();
