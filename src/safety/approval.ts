import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { generateApprovalToken } from '../utils/id-generator.js';
import { getTokenStore } from '../persistence/token-store.js';

export class ApprovalError extends Error {
  constructor(reason: string) {
    super(`Approval token error: ${reason}`);
    this.name = 'ApprovalError';
  }
}

/** Issue a single-use approval token bound to the tool name and payload hash */
export function createApprovalToken(toolName: string, executePayload: unknown): string {
  const token = generateApprovalToken();
  getTokenStore().set({
    id: token,
    toolName,
    payloadHash: hashPayload(executePayload),
    expiresAt: Date.now() + env.FORMA_APPROVAL_TOKEN_TTL * 1000,
  });
  return token;
}

/**
 * Verify and consume an approval token.
 * Throws ApprovalError on any mismatch — not found, expired, wrong tool, or changed payload.
 */
export function verifyAndConsumeToken(
  token: string,
  toolName: string,
  executePayload: unknown,
): void {
  const store = getTokenStore();
  const entry = store.get(token);

  if (!entry) {
    throw new ApprovalError(
      `Token "${token}" not found. It may have expired, already been used, or not exist. ` +
        `Call with dry_run=true to obtain a fresh token.`,
    );
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(token);
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

  store.delete(token); // single-use: consume immediately
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
