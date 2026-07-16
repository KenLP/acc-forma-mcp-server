import { env } from '../config/env.js';
import type { McpToolResult } from '../tools/_types.js';
import { getIdempotencyStore } from '../persistence/idempotency-store.js';

export class IdempotencyError extends Error {
  constructor(reason: string) {
    super(`Idempotency error: ${reason}`);
    this.name = 'IdempotencyError';
  }
}

/**
 * Look up a cached result for `key`, bound to the operation identity.
 *
 * A key is only a valid replay of the SAME operation — same tool, same execute
 * payload. Reusing a key for a different operation would otherwise return the
 * previous operation's cached result and silently skip both execution and the
 * approval check, so that case throws instead.
 */
export function checkIdempotency(
  key: string,
  toolName: string,
  payloadHash: string,
): McpToolResult | null {
  const rec = getIdempotencyStore().check(key);
  if (!rec) return null;
  if (rec.toolName !== toolName || rec.payloadHash !== payloadHash) {
    throw new IdempotencyError(
      `idempotency_key "${key}" was already used for a different operation ` +
        `(tool "${rec.toolName}"). Keys are bound to the exact tool + payload — ` +
        `use a fresh key (e.g. a new UUID) for each distinct operation.`,
    );
  }
  return rec.result;
}

export function storeIdempotencyResult(
  key: string,
  toolName: string,
  payloadHash: string,
  result: McpToolResult,
): void {
  getIdempotencyStore().store(
    key,
    { toolName, payloadHash, result },
    Date.now() + env.FORMA_APPROVAL_TOKEN_TTL * 1000,
  );
}
