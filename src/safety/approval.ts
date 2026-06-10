import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { generateApprovalToken } from '../utils/id-generator.js';

interface PendingApproval {
  token: string;
  toolName: string;
  payloadHash: string;
  expiresAt: number; // unix ms
}

// In-memory store — single-use, TTL-bound.
// LIMITATION: tokens are lost on process restart and cannot be shared across
// multiple server processes. Single-process deployment only.
// See docs/REMEDIATION-PLAN.md Fix 6 for the durable-store migration path.
const pending = new Map<string, PendingApproval>();

export class ApprovalError extends Error {
  constructor(reason: string) {
    super(`Approval token error: ${reason}`);
    this.name = 'ApprovalError';
  }
}

/** Issue a single-use approval token bound to the tool name and payload hash */
export function createApprovalToken(toolName: string, executePayload: unknown): string {
  const token = generateApprovalToken();
  pending.set(token, {
    token,
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
  const entry = pending.get(token);

  if (!entry) {
    throw new ApprovalError(
      `Token "${token}" not found. It may have expired, already been used, or not exist. ` +
        `Call with dry_run=true to obtain a fresh token.`,
    );
  }

  if (Date.now() > entry.expiresAt) {
    pending.delete(token);
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

  pending.delete(token); // single-use: consume immediately
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf-8').digest('hex');
}

// GC expired tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pending.entries()) {
    if (now > entry.expiresAt) pending.delete(token);
  }
}, 60_000).unref();
