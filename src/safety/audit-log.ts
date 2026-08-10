import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../config/env.js';
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
  | 'outcome_unknown'
  /** The tool requires an auth mode the server is not currently running in. */
  | 'denied_auth_mode'
  /** dry_run=false was called with no approval_token, in preview_required mode. */
  | 'denied_missing_approval'
  /** approval_token was present but invalid, expired, already consumed, or bound to a different payload. */
  | 'denied_approval'
  /** idempotency_key was reused for a different operation (different tool or payload). */
  | 'denied_idempotency'
  /** A cached result was returned for a repeated idempotency_key; the APS call did NOT re-execute. */
  | 'idempotent_replay';

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

// Each audit directory is its own independent hash chain (one per tenant in remote mode —
// env.FORMA_AUDIT_DIR is what the tenancy layer overrides per tenant, see CLAUDE.md). Keyed
// by the resolved dir, lazily populated on first use per dir via loadLastHashFromFile below,
// so a restart doesn't silently break any chain by resetting it to 'sha256:genesis'.
const lastHashByDir = new Map<string, string>();

function loadLastHashFromFile(dir: string): string {
  try {
    const filePath = todayLogFile(dir);
    if (!existsSync(filePath)) return 'sha256:genesis';
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trimEnd().split('\n').filter(Boolean);
    if (lines.length === 0) return 'sha256:genesis';
    const last = JSON.parse(lines[lines.length - 1]!) as { this_hash?: string };
    return typeof last.this_hash === 'string' ? last.this_hash : 'sha256:genesis';
  } catch (err) {
    logger.warn({ err, auditDir: dir }, 'audit-log: failed to restore lastHash from file — chain will restart from genesis');
    return 'sha256:genesis';
  }
}

function getLastHash(dir: string): string {
  let hash = lastHashByDir.get(dir);
  if (hash === undefined) {
    hash = loadLastHashFromFile(dir);
    lastHashByDir.set(dir, hash);
  }
  return hash;
}

function todayLogFile(dir: string): string {
  const d = new Date();
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return join(dir, `audit-${date}.jsonl`);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    // 0o700 / 0o600: the audit log and state.db hold project data and must not be
    // world-readable. POSIX only — on Windows the file inherits the directory ACL.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function appendAuditEntry(
  params: {
    tool: string;
    kind: 'read' | 'mutation';
    stage: AuditStage;
    projectId?: string;
    inputRedacted: unknown;
    outputSummary: unknown;
    approvalToken?: string;
  },
  env: Env,
): void {
  // Skip read entries if disabled
  if (!env.FORMA_AUDIT_INCLUDE_READS && params.kind === 'read') return;

  const dir = env.FORMA_AUDIT_DIR;

  try {
    ensureDir(dir);
    const prevHash = getLastHash(dir);

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
      prev_hash: prevHash,
    };

    // Strip prev_hash before hashing so the canonical form matches what
    // verifyChain reconstructs (it also strips prev_hash via destructuring).
    const { prev_hash: _ph, ...restForHash } = partial; void _ph;
    const thisHash = computeHash(prevHash, restForHash);
    const entry: AuditEntry = { ...partial, this_hash: thisHash };
    appendFileSync(todayLogFile(dir), JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    lastHashByDir.set(dir, thisHash);
  } catch (err) {
    logger.error({ err }, 'Failed to write audit log entry');
    if (env.FORMA_AUDIT_FAIL_CLOSED) {
      throw new AuditPersistenceError(err);
    }
  }
}

/**
 * Delete audit JSONL files older than FORMA_AUDIT_RETENTION_DAYS days.
 * Called once at startup; non-fatal on any error. Prunes both the root audit dir and, one
 * level deep, any tenant subdirectory (FORMA_AUDIT_DIR/<tenantId>/) — no deeper recursion.
 */
export function pruneOldAuditFiles(env: Env): void {
  const dir = env.FORMA_AUDIT_DIR;
  if (!existsSync(dir)) return;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - env.FORMA_AUDIT_RETENTION_DAYS);
  const cutoffMs = cutoff.getTime();

  let pruned = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    const auditFiles = entries
      .filter((e) => e.isFile() && /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(e.name))
      .map((e) => e.name);
    pruned += pruneFilesInDir(dir, auditFiles, cutoffMs);

    const subDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const name of subDirs) {
      const subDir = join(dir, name);
      const subFiles = readdirSync(subDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      pruned += pruneFilesInDir(subDir, subFiles, cutoffMs);
    }
  } catch (err) {
    logger.warn({ err, auditDir: dir }, 'audit-log: failed to read audit dir for pruning');
  }

  if (pruned > 0) {
    logger.info({ pruned, retentionDays: env.FORMA_AUDIT_RETENTION_DAYS }, 'audit-log: retention prune complete');
  }
}

function pruneFilesInDir(dir: string, files: string[], cutoffMs: number): number {
  let pruned = 0;
  for (const file of files) {
    const dateStr = file.slice('audit-'.length, -'.jsonl'.length);
    const fileMs = new Date(`${dateStr}T00:00:00Z`).getTime();
    if (isNaN(fileMs) || fileMs >= cutoffMs) continue;
    try {
      unlinkSync(join(dir, file));
      pruned++;
      logger.info({ file }, 'audit-log: pruned expired audit file');
    } catch (err) {
      logger.warn({ err, file }, 'audit-log: failed to delete expired audit file');
    }
  }
  return pruned;
}
