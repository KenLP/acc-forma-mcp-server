import type { Env } from '../config/env.js';
import type { McpToolResult } from '../tools/_types.js';
import { getIdempotencyStore } from '../persistence/idempotency-store.js';
import type { IdempotencyRecord } from '../persistence/idempotency-store.js';

export class IdempotencyError extends Error {
  constructor(reason: string) {
    super(`Idempotency error: ${reason}`);
    this.name = 'IdempotencyError';
  }
}

/**
 * Look up a cached result for `key`, bound to the operation identity AND the tenant that
 * created it (`tenantId` undefined = local mode, stored as tenant `''`).
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
  tenantId?: string,
): McpToolResult | null {
  const rec = getIdempotencyStore().check(tenantId ?? '', key);
  if (!rec) return null;
  return resultOrThrow(rec, key, toolName, payloadHash);
}

function resultOrThrow(
  rec: IdempotencyRecord,
  key: string,
  toolName: string,
  payloadHash: string,
): McpToolResult {
  if (rec.toolName !== toolName || rec.payloadHash !== payloadHash) {
    throw new IdempotencyError(
      `idempotency_key "${key}" was already used for a different operation ` +
        `(tool "${rec.toolName}"). Keys are bound to the exact tool + payload — ` +
        `use a fresh key (e.g. a new UUID) for each distinct operation.`,
    );
  }
  if (rec.result === null) {
    throw new IdempotencyError(
      `an earlier call with idempotency_key "${key}" is still running or ended without a ` +
        `known outcome, so this call was not executed. Check meta_list_changelog for that ` +
        `operation before retrying with a new key.`,
    );
  }
  return rec.result;
}

/**
 * Claims `key` for this operation before it executes. Returns `null` when the caller holds
 * the key and must execute (then storeIdempotencyResult or releaseIdempotency); returns the
 * cached result of a completed identical operation; throws for a different operation or one
 * still in flight. Replaces a check-then-store sequence, where two concurrent calls with the
 * same key could both pass the check and both execute.
 */
export function reserveIdempotency(
  key: string,
  toolName: string,
  payloadHash: string,
  env: Env,
  tenantId?: string,
): McpToolResult | null {
  const existing = getIdempotencyStore().reserve(
    tenantId ?? '',
    key,
    { toolName, payloadHash },
    Date.now() + env.FORMA_APPROVAL_TOKEN_TTL * 1000,
  );
  if (!existing) return null;
  return resultOrThrow(existing, key, toolName, payloadHash);
}

/** Frees a reservation whose operation never reached Autodesk, so the same key can be retried. */
export function releaseIdempotency(key: string, tenantId?: string): void {
  getIdempotencyStore().release(tenantId ?? '', key);
}

export function storeIdempotencyResult(
  key: string,
  toolName: string,
  payloadHash: string,
  result: McpToolResult,
  env: Env,
  tenantId?: string,
): void {
  getIdempotencyStore().store(
    tenantId ?? '',
    key,
    { toolName, payloadHash, result },
    Date.now() + env.FORMA_APPROVAL_TOKEN_TTL * 1000,
  );
}
