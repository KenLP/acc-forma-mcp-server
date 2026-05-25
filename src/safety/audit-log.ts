import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { redact } from '../utils/redact.js';
import { generateEventId } from '../utils/id-generator.js';
import { computeHash } from './hash-chain.js';

export type AuditStage =
  | 'preview'
  | 'executed'
  | 'denied_readonly'
  | 'denied_allowlist'
  | 'denied_rate_limit'
  | 'denied_business_rule'
  | 'failed_api';

export interface AuditEntry {
  ts: string;
  id: string;
  tool: string;
  kind: 'read' | 'mutation';
  stage: AuditStage;
  actor: { auth_mode: string; ssa_id: string | null; user_email: string | null };
  project_id?: string;
  input_redacted: unknown;
  output_summary: unknown;
  approval_token?: string;
  prev_hash: string;
  this_hash: string;
}

// Module-level chain state (persists across calls for the process lifetime)
let lastHash = 'sha256:genesis';

function todayLogFile(): string {
  const d = new Date();
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return join(env.FORMA_AUDIT_DIR, `audit-${date}.jsonl`);
}

function ensureDir(): void {
  if (!existsSync(env.FORMA_AUDIT_DIR)) {
    mkdirSync(env.FORMA_AUDIT_DIR, { recursive: true });
  }
}

export function appendAuditEntry(params: {
  tool: string;
  kind: 'read' | 'mutation';
  stage: AuditStage;
  projectId?: string;
  inputRedacted: unknown;
  outputSummary: unknown;
  approvalToken?: string;
}): void {
  // Skip read entries if disabled
  if (!env.FORMA_AUDIT_INCLUDE_READS && params.kind === 'read') return;

  try {
    ensureDir();

    // Build entry without this_hash first (needed for hash computation)
    const partial: Omit<AuditEntry, 'this_hash'> = {
      ts: new Date().toISOString(),
      id: generateEventId(),
      tool: params.tool,
      kind: params.kind,
      stage: params.stage,
      actor: {
        auth_mode: env.APS_AUTH_MODE,
        ssa_id: env.SSA_ID ?? null,
        user_email: null, // populated in Phase 3 (3LO)
      },
      ...(params.projectId !== undefined ? { project_id: params.projectId } : {}),
      input_redacted: redact(params.inputRedacted),
      output_summary: redact(params.outputSummary),
      ...(params.approvalToken !== undefined ? { approval_token: params.approvalToken } : {}),
      prev_hash: lastHash,
    };

    const thisHash = computeHash(lastHash, partial as Record<string, unknown>);
    const entry: AuditEntry = { ...partial, this_hash: thisHash };
    lastHash = thisHash;

    appendFileSync(todayLogFile(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    // Audit failure MUST NOT crash the server
    logger.error({ err }, 'Failed to write audit log entry');
  }
}
