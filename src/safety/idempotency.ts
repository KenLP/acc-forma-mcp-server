import { env } from '../config/env.js';
import type { McpToolResult } from '../tools/_types.js';
import { getIdempotencyStore } from '../persistence/idempotency-store.js';

export function checkIdempotency(key: string): McpToolResult | null {
  return getIdempotencyStore().check(key);
}

export function storeIdempotencyResult(key: string, result: McpToolResult): void {
  getIdempotencyStore().store(key, result, Date.now() + env.FORMA_APPROVAL_TOKEN_TTL * 1000);
}
