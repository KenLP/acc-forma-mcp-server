/**
 * Tenant backup / restore / master-key lifecycle CLI — closes the "residual operational
 * concerns remain around master-key backup, rotation, and key versioning" finding in
 * docs/audits/AUDIT_2026-08-12_remote-mcp.md.
 *
 * Why this exists at all: the `tenants` table IS the credential. A tenant row carries the
 * robot's encrypted private key and the sha256 of its bearer key, and neither can be
 * regenerated — losing the row means re-provisioning every customer by hand. It lives on a
 * single Fly volume (fly.toml `[mounts] source = "forma_data"`), so it needs a real backup
 * path, not just the volume's own snapshots.
 *
 * Usage (inside the container — see docs/runbooks/RUNBOOK_backup-and-restore.md):
 *
 *   node dist/backup-tenants.js snapshot   [--db <path>] --out <path>
 *   node dist/backup-tenants.js verify-key [--db <path>] [--stdin]
 *   node dist/backup-tenants.js restore    [--db <path>] --from <path> [--apply] [--backup-out <path>]
 *   node dist/backup-tenants.js rotate-key [--db <path>] [--apply] [--backup-out <path>]
 *
 * `--db` defaults to the container's volume mount, /data/state.db. Keys never travel in
 * argv: verify-key reads FORMA_MASTER_KEY or, with --stdin, stdin; rotate-key reads the
 * current key from FORMA_MASTER_KEY and the new one from stdin, always.
 *
 * Dev usage via tsx: `npx tsx scripts/backup-tenants.ts ...`.
 *
 * Two deliberate departures from the other CLIs in this directory:
 *
 *   1. No `src/config/env.js` import. env.ts throws at import time when APS_CLIENT_ID and
 *      friends are absent, which would make this unusable for the one case it most needs to
 *      serve — verifying an offline master-key backup against a restored copy of the DB on a
 *      machine that has no APS credentials at all.
 *   2. No `getDb()`. That helper runs migrateSchema() on the handle it opens, which is DDL
 *      against the live database — a backup must never mutate its source. Connections here
 *      are `readonly: true` except for the two commands that exist to write (`restore` and
 *      `rotate-key`), and those open read-write only once `--apply` is confirmed.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { decryptSecret, encryptSecret } from '../src/tenancy/crypto.js';
import { parseFlags } from './_cli.js';

const DEFAULT_DB_PATH = '/data/state.db';
const MASTER_KEY_HEX = /^[0-9a-fA-F]{64}$/;

// Per-command flag surfaces. Anything not listed is an error rather than silently ignored,
// because the silent-ignore failure here is "the default path is the production database".
const FLAGS = {
  snapshot: { allowed: new Set(['db', 'out']), booleans: new Set<string>() },
  verifyKey: { allowed: new Set(['db']), booleans: new Set(['stdin']) },
  restore: { allowed: new Set(['db', 'from', 'backup-out']), booleans: new Set(['apply']) },
  rotateKey: { allowed: new Set(['db', 'backup-out']), booleans: new Set(['apply']) },
} as const;

interface TenantRow {
  id: string;
  name: string;
  private_key_ciphertext: string;
  disabled: number;
}

const SELECT_TENANTS =
  'SELECT id, name, private_key_ciphertext, disabled FROM tenants ORDER BY created_at';

function resolveDbPath(flags: Map<string, string>): string {
  const dbPath = flags.get('db') || DEFAULT_DB_PATH;
  if (!existsSync(dbPath)) {
    throw new Error(
      `no database at ${dbPath} — pass --db <path> (default is ${DEFAULT_DB_PATH}, the container's volume mount)`,
    );
  }
  return dbPath;
}

/**
 * Timestamp for a default output filename: ISO 8601 with the characters that are awkward in
 * a shell (`:`) removed, e.g. `2026-09-17T0914`.
 */
function fileTimestamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:]/g, '');
}

/**
 * A non-secret, comparable identifier for a master key: the first 16 hex chars of the sha256
 * of its lower-cased hex form. Lets an operator check that the key written on the offline
 * backup card is the same one production is running without either copy ever being
 * displayed or transmitted.
 *
 * Lower-cased first so that a key transcribed in upper case (a password manager, a hand
 * copy) fingerprints identically to the lower-case one `openssl rand -hex` emits — they
 * decode to the same 32 bytes and decrypt the same rows, so a mismatch would be a false
 * alarm. Truncated deliberately — a full hash of a 32-byte key would be a meaningful
 * brute-force target if it ever leaked into a ticket or a chat log.
 */
function keyFingerprint(masterKeyHex: string): string {
  return createHash('sha256').update(masterKeyHex.toLowerCase()).digest('hex').slice(0, 16);
}

async function readStdin(prompt: string): Promise<string> {
  // Waiting on EOF from a terminal with no prompt reads as a hang. The hint goes to stderr
  // so it never mixes into stdout for a caller that is piping the key in.
  if (process.stdin.isTTY) {
    process.stderr.write(`${prompt} — paste it, press Enter, then Ctrl-D:\n`);
  }
  const chunks: Buffer[] = [];
  // process.stdin's async iterator is typed `any` per chunk; narrow it here so the push
  // below is type-safe rather than silently unchecked.
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Where the master key comes from, in precedence order:
 *
 *   --stdin              piped in; never reaches argv or shell history. The right choice for
 *                        verifying an offline backup copy by hand.
 *   FORMA_MASTER_KEY     the environment the server itself runs with. The right choice when
 *                        checking that production's own key still decrypts production's rows.
 *
 * There is deliberately no `--key <hex>` flag: an argument is visible in the process list to
 * every other process on the host and lands in shell history.
 */
async function resolveMasterKey(flags: Map<string, string>): Promise<string> {
  if (flags.has('stdin')) {
    const key = await readStdin('Master key to verify');
    if (!key) throw new Error('--stdin was passed but nothing arrived on stdin');
    return key;
  }
  const fromEnv = process.env.FORMA_MASTER_KEY;
  if (!fromEnv) {
    throw new Error(
      'no master key available — set FORMA_MASTER_KEY in the environment, or pass --stdin and pipe the key in',
    );
  }
  return fromEnv;
}

function requireEnvMasterKey(purpose: string): string {
  const key = process.env.FORMA_MASTER_KEY;
  if (!key) {
    throw new Error(
      `${purpose} needs the CURRENT key in FORMA_MASTER_KEY. Run this inside the container, ` +
        'where the Fly secret is already in the environment.',
    );
  }
  return key;
}

// ---------------------------------------------------------------------------------------------
// Consistent copies
// ---------------------------------------------------------------------------------------------

interface SnapshotReport {
  out: string;
  tenants: number;
  active: number;
  integrity: string;
}

/**
 * Copies `dbPath` to `out` with SQLite's online backup API, then reopens `out` and checks it.
 *
 * Not a file copy, and not a stylistic preference: the live database runs in WAL mode
 * (`src/persistence/db.ts` sets `journal_mode = WAL`), so committed rows can still be sitting
 * in the `-wal` sidecar when a copy is taken. Copying `state.db` alone silently drops them —
 * on a 400-row WAL-mode reproduction the copy had no `tenants` table at all, because the
 * CREATE TABLE was itself still in the WAL. The backup API reads through the WAL and
 * produces a single self-contained file.
 */
async function writeConsistentSnapshot(dbPath: string, out: string): Promise<SnapshotReport> {
  if (out === dbPath) throw new Error('output path must differ from the source database path');
  if (existsSync(out)) {
    throw new Error(`refusing to overwrite an existing file at ${out} — choose another path`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(out);
  } finally {
    db.close();
  }

  // Verify the artifact rather than trusting that the call returned cleanly: reopen it and
  // read the table this whole exercise exists to protect. A backup nobody has opened is a
  // hope, not a backup.
  const check = new Database(out, { readonly: true });
  try {
    const integrity = check.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new Error(`snapshot failed integrity_check: ${integrity}`);
    }
    const tenants = (check.prepare('SELECT count(*) AS c FROM tenants').get() as { c: number }).c;
    const active = (
      check.prepare('SELECT count(*) AS c FROM tenants WHERE disabled = 0').get() as { c: number }
    ).c;
    return { out, tenants, active, integrity };
  } finally {
    check.close();
  }
}

async function cmdSnapshot(argv: string[]): Promise<void> {
  const flags = parseFlags(argv, FLAGS.snapshot);
  const dbPath = resolveDbPath(flags);
  const out = flags.get('out') || `/data/state-backup-${fileTimestamp()}.db`;
  const report = await writeConsistentSnapshot(dbPath, out);

  console.log(`Snapshot written: ${report.out}`);
  console.log(`  integrity_check: ${report.integrity}`);
  console.log(`  tenants:         ${report.tenants} (${report.active} active)`);
  console.log(
    '\nThis file contains every tenant robot key as AES-256-GCM ciphertext. It is useless\n' +
      'without FORMA_MASTER_KEY — store the two in different places, or the pair is a\n' +
      'single compromise away from every tenant robot credential.',
  );
}

// ---------------------------------------------------------------------------------------------
// verify-key
// ---------------------------------------------------------------------------------------------

/**
 * Decrypts every row with `key`, without printing anything derived from the plaintext beyond
 * its byte length. Returns the rows that failed. Shared by verify-key (reports them) and
 * restore's dry run (refuses to proceed on any).
 */
function findUndecryptableRows(
  rows: TenantRow[],
  key: string,
  log: (line: string) => void,
): string[] {
  const failures: string[] = [];
  for (const row of rows) {
    const status = row.disabled !== 0 ? '[disabled]' : '[active]  ';
    try {
      const pem = decryptSecret(row.private_key_ciphertext, key);
      if (!pem.includes('PRIVATE KEY')) {
        // Decryption succeeded but the plaintext is not a PEM. GCM's auth tag makes this
        // essentially impossible with a wrong key, so it means the row was written with
        // something other than a private key — worth failing loudly rather than passing.
        failures.push(row.id);
        log(`  FAIL  ${status} ${row.id}  ${row.name} — decrypted, but not a PEM`);
        continue;
      }
      log(`  OK    ${status} ${row.id}  ${row.name} (${pem.length} bytes)`);
    } catch (err) {
      failures.push(row.id);
      log(
        `  FAIL  ${status} ${row.id}  ${row.name} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return failures;
}

/**
 * Proves a master key can actually decrypt what is stored — the check that turns "I wrote
 * the key down somewhere" into "I verified the key I wrote down is the right one".
 *
 * Reports per-tenant OK/FAIL and exits non-zero if any row fails. Never prints the key, the
 * decrypted PEM, or any part of either.
 */
async function cmdVerifyKey(argv: string[]): Promise<void> {
  const flags = parseFlags(argv, FLAGS.verifyKey);
  const dbPath = resolveDbPath(flags);
  const masterKey = await resolveMasterKey(flags);

  const db = new Database(dbPath, { readonly: true });
  let rows: TenantRow[];
  try {
    rows = db.prepare(SELECT_TENANTS).all() as TenantRow[];
  } finally {
    db.close();
  }

  console.log(`Database:        ${dbPath}`);
  console.log(`Key fingerprint: ${keyFingerprint(masterKey)}  (sha256 prefix — not the key)`);
  console.log(`Tenants:         ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('No tenant rows to verify — this proves nothing about the key.');
    return;
  }

  const failures = findUndecryptableRows(rows, masterKey, console.log);
  console.log('');
  if (failures.length > 0) {
    console.error(
      `${failures.length} tenant row(s) did not decrypt with this key. Either the key is the wrong\n` +
        'one, or those rows were encrypted under a previous key. Do NOT discard any older\n' +
        'copy of the master key until this reports zero failures.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('All tenant rows decrypt with this key — it is the correct master key.');
}

// ---------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------

/**
 * Replaces the live database's contents with those of a backup file — through SQLite's
 * backup API, with the backup as source and the live path as destination.
 *
 * This is the whole reason the command exists instead of a `mv` in the runbook. The live
 * file runs in WAL mode, so `state.db-wal` and `state.db-shm` sit next to it; moving a
 * restored file into place under them lets SQLite replay the OLD database's WAL frames onto
 * the NEW file on next open. Going through the backup API writes the restored pages via the
 * destination's own pager, so the sidecars stay coherent, the server's already-open handle
 * sees the restored rows on its next statement, and nothing has to be stopped.
 *
 * Dry run by default: proves the backup decrypts under the CURRENT master key and reports
 * what would change. `--apply` first snapshots the live database (the state being replaced
 * may be the only copy of a tenant provisioned after the backup was taken), then restores.
 */
async function cmdRestore(argv: string[]): Promise<void> {
  const flags = parseFlags(argv, FLAGS.restore);
  const dbPath = resolveDbPath(flags);
  const from = flags.get('from');
  if (!from) throw new Error('restore needs --from <backup file>');
  if (!existsSync(from)) throw new Error(`no backup file at ${from}`);
  if (from === dbPath) throw new Error('--from is the live database itself — nothing to restore');
  const apply = flags.has('apply');
  const masterKey = requireEnvMasterKey('restore');

  console.log(`Live database: ${dbPath}`);
  console.log(`Restore from:  ${from}`);
  console.log(`Key:           ${keyFingerprint(masterKey)}`);
  console.log(`Mode:          ${apply ? 'APPLY' : 'dry run (pass --apply to commit)'}\n`);

  // Read both sides up front, readonly. The backup must decrypt under the key the server
  // is running with, or restoring it just moves the outage from "rows missing" to "rows
  // unreadable".
  const source = new Database(from, { readonly: true });
  let incoming: TenantRow[];
  try {
    const integrity = source.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') throw new Error(`${from} fails integrity_check: ${integrity}`);
    incoming = source.prepare(SELECT_TENANTS).all() as TenantRow[];
  } finally {
    source.close();
  }
  const liveDb = new Database(dbPath, { readonly: true });
  let current: TenantRow[];
  try {
    current = liveDb.prepare(SELECT_TENANTS).all() as TenantRow[];
  } finally {
    liveDb.close();
  }

  console.log(`Backup contains ${incoming.length} tenant row(s):`);
  const failures = findUndecryptableRows(incoming, masterKey, console.log);
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} row(s) in the backup do not decrypt under the current FORMA_MASTER_KEY. ` +
        'Restoring would leave them unreadable. Nothing was written.',
    );
    process.exitCode = 1;
    return;
  }

  const incomingIds = new Set(incoming.map((r) => r.id));
  const lostIds = current.filter((r) => !incomingIds.has(r.id)).map((r) => r.id);
  console.log(`\nLive table has ${current.length} row(s).`);
  if (lostIds.length > 0) {
    console.log(
      `${lostIds.length} live tenant(s) are NOT in the backup and will be gone after restore\n` +
        '(their bearer keys will 401 — see the runbook on re-provisioning):',
    );
    for (const id of lostIds) console.log(`  ${id}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing was written. Re-run with --apply to restore.');
    return;
  }

  const backupOut = flags.get('backup-out') || `${dbPath}.pre-restore-${fileTimestamp()}.db`;
  const pre = await writeConsistentSnapshot(dbPath, backupOut);
  console.log(`\nPre-restore snapshot of the live database: ${pre.out} (${pre.tenants} tenants)`);

  const restoreSource = new Database(from, { readonly: true });
  try {
    await restoreSource.backup(dbPath);
  } finally {
    restoreSource.close();
  }

  // Prove what landed, from a fresh handle, under the running key.
  const after = new Database(dbPath, { readonly: true });
  let landed: TenantRow[];
  try {
    landed = after.prepare(SELECT_TENANTS).all() as TenantRow[];
  } finally {
    after.close();
  }
  const postFailures = findUndecryptableRows(landed, masterKey, () => undefined);
  if (landed.length !== incoming.length || postFailures.length > 0) {
    throw new Error(
      `restore verification failed: live table has ${landed.length} row(s) (expected ${incoming.length}), ` +
        `${postFailures.length} undecryptable. The pre-restore snapshot is at ${pre.out}.`,
    );
  }

  console.log(`\nRestored ${landed.length} tenant row(s); all verified under the current key.`);
  console.log(
    'The running server picks the rows up on its next statement — no restart required.\n' +
      `Keep ${pre.out} until a real tool call has succeeded, then delete it from the volume.`,
  );
}

// ---------------------------------------------------------------------------------------------
// rotate-key
// ---------------------------------------------------------------------------------------------

/**
 * Re-encrypts every tenant's robot private key from the current master key to a new one.
 *
 * The old key comes from FORMA_MASTER_KEY (inside the container that is already the running
 * secret — the thing being rotated away from); the new key is read from stdin. Neither is
 * ever accepted as an argument.
 *
 * Dry run by default, `--apply` to commit — the same shape as this server's own
 * `preview_required` mutation gate, for the same reason: the destructive version of this
 * operation should require a second, deliberate act. The dry run holds a read-only handle;
 * the read-write one is opened only after `--apply` and the pre-rotation snapshot.
 *
 * Under `--apply`, the SELECT, every UPDATE, and the read-back verification all run inside
 * ONE transaction. That is what makes the guarantee "either every row is under the new key
 * or nothing changed" actually hold: a row that fails to decrypt on read-back throws inside
 * the transaction, so better-sqlite3 rolls the whole thing back.
 *
 * Ordering matters operationally and the tool cannot enforce it, so it prints it:
 * `buildTenantContext` decrypts only on a cache miss, and the machine runs with
 * `min_machines_running = 0`, so between this command committing and the Fly secret being
 * updated, a cold tenant lookup fails — the transport turns that throw into a 500. Rotate
 * and update the secret back to back; see docs/runbooks/RUNBOOK_backup-and-restore.md.
 */
async function cmdRotateKey(argv: string[]): Promise<void> {
  const flags = parseFlags(argv, FLAGS.rotateKey);
  const dbPath = resolveDbPath(flags);
  const apply = flags.has('apply');
  const oldKey = requireEnvMasterKey('rotate-key');

  const newKey = await readStdin('NEW master key (generate with `openssl rand -hex 32`)');
  if (!newKey) {
    throw new Error(
      'the NEW master key must arrive on stdin — generate one with `openssl rand -hex 32` and pipe it in',
    );
  }
  if (!MASTER_KEY_HEX.test(newKey)) {
    throw new Error(
      `the new master key must be 64 hex characters (32 bytes); got ${newKey.length} characters`,
    );
  }
  if (newKey.toLowerCase() === oldKey.toLowerCase()) {
    throw new Error('the new master key is identical to the current one — nothing to rotate');
  }

  console.log(`Database:    ${dbPath}`);
  console.log(`Current key: ${keyFingerprint(oldKey)}`);
  console.log(`New key:     ${keyFingerprint(newKey)}`);
  console.log(`Mode:        ${apply ? 'APPLY' : 'dry run (pass --apply to commit)'}\n`);

  /**
   * Decrypts under the old key, re-encrypts under the new, and proves the new ciphertext
   * round-trips — all in memory. Returns the failures rather than throwing so the caller
   * can list every bad row, not just the first.
   */
  function reEncryptAll(
    rows: TenantRow[],
    log: (line: string) => void,
  ): { rotated: Array<{ id: string; ciphertext: string }>; failures: string[] } {
    const rotated: Array<{ id: string; ciphertext: string }> = [];
    const failures: string[] = [];
    for (const row of rows) {
      try {
        const pem = decryptSecret(row.private_key_ciphertext, oldKey);
        const reEncrypted = encryptSecret(pem, newKey);
        if (decryptSecret(reEncrypted, newKey) !== pem) {
          // Belt and braces: encryptSecret/decryptSecret are inverses, so this cannot
          // normally fire. If it ever does, writing the row would destroy the credential.
          failures.push(`${row.id} (${row.name}) — re-encrypted value did not round-trip`);
          continue;
        }
        rotated.push({ id: row.id, ciphertext: reEncrypted });
        log(`  ready  ${row.id}  ${row.name}`);
      } catch (err) {
        failures.push(
          `${row.id} (${row.name}) — ${err instanceof Error ? err.message : String(err)}`,
        );
        log(`  FAIL   ${row.id}  ${row.name}`);
      }
    }
    return { rotated, failures };
  }

  function reportFailures(failures: string[], total: number): void {
    console.error(`\n${failures.length} of ${total} row(s) could not be re-encrypted:`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      '\nNothing was written. FORMA_MASTER_KEY is not the key those rows were encrypted ' +
        'under, so rotating now would strand them. Resolve that first.',
    );
    process.exitCode = 1;
  }

  // Phase 1 — dry run, read-only handle. Always runs, so `--apply` still gets the full
  // per-row preview before anything irreversible happens.
  const preview = new Database(dbPath, { readonly: true });
  let rows: TenantRow[];
  try {
    rows = preview.prepare(SELECT_TENANTS).all() as TenantRow[];
  } finally {
    preview.close();
  }
  if (rows.length === 0) {
    console.log('No tenant rows — nothing to re-encrypt. Update the Fly secret directly.');
    return;
  }
  const dry = reEncryptAll(rows, console.log);
  if (dry.failures.length > 0) {
    reportFailures(dry.failures, rows.length);
    return;
  }
  if (!apply) {
    console.log(
      `\nDry run: ${dry.rotated.length} of ${rows.length} tenant row(s) re-encrypt cleanly under the new key.`,
    );
    console.log('Nothing was written. Re-run with --apply to commit.');
    return;
  }

  // Phase 2 — pre-rotation snapshot, before the old ciphertext is destroyed. This is the
  // only operation in the system that overwrites a credential in place: the row's previous
  // value is unrecoverable once the UPDATE commits, so the backup is a precondition of
  // applying, not an optional courtesy. Taken here rather than left to the runbook: the
  // step that must never be skipped should not be the step a human has to remember.
  const backupOut = flags.get('backup-out') || `${dbPath}.pre-rotate-${fileTimestamp()}.db`;
  const backup = await writeConsistentSnapshot(dbPath, backupOut);
  console.log(
    `\nPre-rotation backup: ${backup.out} (${backup.tenants} tenants, integrity ${backup.integrity})`,
  );
  console.log(
    `  Decrypts with the CURRENT key (${keyFingerprint(oldKey)}) — keep both until the rotation is confirmed.`,
  );

  // Phase 3 — one transaction: re-read (a row provisioned since the preview is included,
  // not stranded), re-encrypt, write, read back, verify. Any throw inside rolls back all
  // of it. better-sqlite3 transactions are synchronous, which is why the async snapshot
  // above had to happen first.
  const db = new Database(dbPath);
  let rotatedCount = 0;
  try {
    const update = db.prepare('UPDATE tenants SET private_key_ciphertext = ? WHERE id = ?');
    const rotateAll = db.transaction((): number => {
      const inTx = db.prepare(SELECT_TENANTS).all() as TenantRow[];
      // Phase 1 already printed the per-row lines; this pass is silent.
      const { rotated, failures } = reEncryptAll(inTx, () => undefined);
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} row(s) changed between preview and apply and do not decrypt under the current key: ` +
            failures.join('; '),
        );
      }
      for (const item of rotated) {
        const result = update.run(item.ciphertext, item.id);
        if (result.changes !== 1) {
          throw new Error(`UPDATE touched ${result.changes} rows for tenant ${item.id}`);
        }
      }
      const after = db.prepare(SELECT_TENANTS).all() as TenantRow[];
      if (after.length !== rotated.length) {
        throw new Error(`row count changed mid-transaction: ${rotated.length} -> ${after.length}`);
      }
      for (const row of after) decryptSecret(row.private_key_ciphertext, newKey);
      return rotated.length;
    });
    rotatedCount = rotateAll();
  } catch (err) {
    // The transaction rolled back: the table is exactly as it was, and the snapshot is a
    // spare copy of that same state. Say so explicitly — an operator reading a bare decrypt
    // error after `--apply` would reasonably assume the worst.
    throw new Error(
      `rotation rolled back, the database is unchanged (${err instanceof Error ? err.message : String(err)}).\n` +
        `The pre-rotation snapshot at ${backup.out} is a copy of the current, unrotated state.`,
    );
  } finally {
    db.close();
  }

  console.log(`\nRotated ${rotatedCount} tenant row(s). All re-read and verified under the new key.`);
  console.log('\nTHE DATABASE AND THE RUNNING SERVER NOW DISAGREE. Do this next, without pausing:');
  console.log('');
  console.log('  fly secrets set FORMA_MASTER_KEY=<the new key> -a bimlynx-mcp');
  console.log('');
  console.log(
    'That restarts the app onto the new key. Until it lands, any tenant not already in\n' +
      'the in-process provider cache fails its lookup and the caller sees a 500.\n' +
      'Then store the new key exactly as §1.3 of the backup runbook describes, and keep\n' +
      'the old key until `verify-key` reports zero failures against a fresh snapshot.',
  );
  console.log(
    `\nRollback, if the new key turns out to be wrong:\n` +
      `  node dist/backup-tenants.js restore --from ${backup.out} --apply\n` +
      'with FORMA_MASTER_KEY still set to the OLD key. That file decrypts with the old key,\n' +
      'so delete it from the volume only once the rotation is confirmed working.',
  );
}

// ---------------------------------------------------------------------------------------------

const USAGE =
  'Usage: backup-tenants <command> [flags]\n' +
  '  snapshot   [--db <path>] --out <path>\n' +
  '  verify-key [--db <path>] [--stdin]\n' +
  '  restore    [--db <path>] --from <path> [--apply] [--backup-out <path>]\n' +
  '  rotate-key [--db <path>] [--apply] [--backup-out <path>]     (new key on stdin)';

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'snapshot':
      await cmdSnapshot(rest);
      break;
    case 'verify-key':
      await cmdVerifyKey(rest);
      break;
    case 'restore':
      await cmdRestore(rest);
      break;
    case 'rotate-key':
      await cmdRotateKey(rest);
      break;
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
