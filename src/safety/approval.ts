import { createHash } from 'node:crypto';
import type { Env } from '../config/env.js';
import { generateApprovalToken } from '../utils/id-generator.js';
import { getTokenStore } from '../persistence/token-store.js';

export class ApprovalError extends Error {
  constructor(reason: string) {
    super(`Approval token error: ${reason}`);
    this.name = 'ApprovalError';
  }
}

/**
 * Issue a single-use approval token bound to the tool name, payload hash, and tenant.
 * `tenantId` undefined (local mode) is stored as tenant `''` — see ToolContext.tenantId.
 */
export function createApprovalToken(
  toolName: string,
  executePayload: unknown,
  env: Env,
  tenantId?: string,
): string {
  const token = generateApprovalToken();
  getTokenStore().set(tenantId ?? '', {
    id: token,
    toolName,
    payloadHash: hashPayload(executePayload),
    expiresAt: Date.now() + env.FORMA_APPROVAL_TOKEN_TTL * 1000,
  });
  return token;
}

/**
 * Verify and consume an approval token.
 * Throws ApprovalError on any mismatch — not found, expired, wrong tool, changed payload,
 * or (implicitly, via the tenant-scoped store lookup) issued for a different tenant. A
 * token from tenant A looked up under tenant B simply isn't found — same error as a token
 * that never existed, so no tenant identity leaks through the error message.
 */
export function verifyAndConsumeToken(
  token: string,
  toolName: string,
  executePayload: unknown,
  env: Env,
  tenantId?: string,
): void {
  const store = getTokenStore();
  const tid = tenantId ?? '';
  const entry = store.get(tid, token);

  if (!entry) {
    throw new ApprovalError(
      `Token "${token}" not found. It may have expired, already been used, or not exist. ` +
        `Call with dry_run=true to obtain a fresh token.`,
    );
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(tid, token);
    throw new ApprovalError(
      `Token "${token}" expired (TTL: ${env.FORMA_APPROVAL_TOKEN_TTL}s). ` +
        `Call with dry_run=true again to get a new token.`,
    );
  }

  if (entry.toolName !== toolName) {
    throw new ApprovalError(
      `Token "${token}" was issued for tool "${entry.toolName}", not "${toolName}".`,
    );
  }

  const currentHash = hashPayload(executePayload);
  if (currentHash !== entry.payloadHash) {
    throw new ApprovalError(
      `The payload changed since dry_run=true was called. ` +
        `The approval token is cryptographically bound to the original payload. ` +
        `Call with dry_run=true again to get a new token for the updated payload.`,
    );
  }

  store.delete(tid, token); // single-use: consume immediately
}

/** Canonical payload hash — shared with the idempotency binding in _wrap.ts. */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf-8').digest('hex');
}

/**
 * Non-reversible fingerprint of an approval token, safe to persist in the audit log.
 * The live token must never be written to disk — anyone who can read the JSONL within
 * the TTL could otherwise replay it to execute the mutation. The fingerprint still
 * links a preview entry to its execute entry (same token → same fingerprint).
 */
export function fingerprintToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex').slice(0, 16);
}

// GC is handled inside getTokenStore() — memory backend runs a per-minute interval,
// SQLite backend is cleaned up by cleanupExpiredRows() at startup.
