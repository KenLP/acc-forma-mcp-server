import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { redact } from '../utils/redact.js';
import { generateEventId } from '../utils/id-generator.js';
import { computeHash } from './hash-chain.js';

export class AuditPersistenceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'AuditPersistenceError';
    if (cause instanceof Error) this.cause = cause;
  }
}

export type AuditStage =
  | 'preview'
  | 'executed'
  | 'denied_readonly'
  | 'denied_allowlist'
  | 'denied_rate_limit'
  | 'denied_business_rule'
  | 'failed_api'
  /**
   * A mutation request never got a response (timeout / socket error), so whether APS
   * applied it is unknown. Distinct from `failed_api`, which means the call definitively
   * failed — an audit log that cannot tell the two apart is misleading precisely when it
   * matters most.
   */
  | 'outcome_unknown';

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

// Restore chain state from the last line of today's audit file so a restart
// doesn't silently break the chain by resetting to 'sha256:genesis'.
function loadLastHashFromFile(): string {
  try {
    const filePath = todayLogFile();
    if (!existsSync(filePath)) return 'sha256:genesis';
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trimEnd().split('\n').filter(Boolean);
    if (lines.length === 0) return 'sha256:genesis';
    const last = JSON.parse(lines[lines.length - 1]!) as { this_hash?: string };
    return typeof last.this_hash === 'string' ? last.this_hash : 'sha256:genesis';
  } catch (err) {
    logger.warn({ err, auditDir: env.FORMA_AUDIT_DIR }, 'audit-log: failed to restore lastHash from file — chain will restart from genesis');
    return 'sha256:genesis';
  }
}

// Module-level chain state (persists across calls for the process lifetime)
let lastHash = loadLastHashFromFile();

function todayLogFile(): string {
  const d = new Date();
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return join(env.FORMA_AUDIT_DIR, `audit-${date}.jsonl`);
}

function ensureDir(): void {
  if (!existsSync(env.FORMA_AUDIT_DIR)) {
    // 0o700 / 0o600: the audit log and state.db hold project data and must not be
    // world-readable. POSIX only — on Windows the file inherits the directory ACL.
    mkdirSync(env.FORMA_AUDIT_DIR, { recursive: true, mode: 0o700 });
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

    // Strip prev_hash before hashing so the canonical form matches what
    // verifyChain reconstructs (it also strips prev_hash via destructuring).
    const { prev_hash: _ph, ...restForHash } = partial; void _ph;
    const thisHash = computeHash(lastHash, restForHash);
    const entry: AuditEntry = { ...partial, this_hash: thisHash };
    appendFileSync(todayLogFile(), JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    lastHash = thisHash;
  } catch (err) {
    logger.error({ err }, 'Failed to write audit log entry');
    if (env.FORMA_AUDIT_FAIL_CLOSED) {
      throw new AuditPersistenceError(err);
    }
  }
}

/**
 * Delete audit JSONL files older than FORMA_AUDIT_RETENTION_DAYS days.
 * Called once at startup; non-fatal on any error.
 */
export function pruneOldAuditFiles(): void {
  if (!existsSync(env.FORMA_AUDIT_DIR)) return;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - env.FORMA_AUDIT_RETENTION_DAYS);
  const cutoffMs = cutoff.getTime();

  let pruned = 0;
  try {
    const files = readdirSync(env.FORMA_AUDIT_DIR).filter((f) =>
      /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f),
    );

    for (const file of files) {
      const dateStr = file.slice('audit-'.length, -'.jsonl'.length);
      const fileMs = new Date(`${dateStr}T00:00:00Z`).getTime();
      if (isNaN(fileMs) || fileMs >= cutoffMs) continue;
      try {
        unlinkSync(join(env.FORMA_AUDIT_DIR, file));
        pruned++;
        logger.info({ file }, 'audit-log: pruned expired audit file');
      } catch (err) {
        logger.warn({ err, file }, 'audit-log: failed to delete expired audit file');
      }
    }
  } catch (err) {
    logger.warn({ err, auditDir: env.FORMA_AUDIT_DIR }, 'audit-log: failed to read audit dir for pruning');
  }

  if (pruned > 0) {
    logger.info({ pruned, retentionDays: env.FORMA_AUDIT_RETENTION_DAYS }, 'audit-log: retention prune complete');
  }
}
