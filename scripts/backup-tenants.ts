/**
 * Tenant backup / master-key verification CLI — closes the "residual operational concerns
 * remain around master-key backup" finding in docs/audits/AUDIT_2026-08-12_remote-mcp.md.
 *
 * Why this exists at all: the `tenants` table IS the credential. A tenant row carries the
 * robot's encrypted private key and the sha256 of its bearer key, and neither can be
 * regenerated — losing the row means re-provisioning every customer by hand. It lives on a
 * single Fly volume (fly.toml `[mounts] source = "forma_data"`), so it needs a real backup
 * path, not just the volume's own snapshots.
 *
 * Usage (inside the container — see docs/runbooks/RUNBOOK_backup-and-restore.md):
 *
 *   node dist/backup-tenants.js snapshot --out /data/backup.db
 *   node dist/backup-tenants.js verify-key
 *   node dist/backup-tenants.js verify-key --stdin        # key piped in, not in argv
 *   node dist/backup-tenants.js verify-key --db /path/to/restored-backup.db
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
 *      against the live database — a backup must never mutate its source. Every connection
 *      opened here is `readonly: true`.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { decryptSecret } from '../src/tenancy/crypto.js';

const DEFAULT_DB_PATH = '/data/state.db';

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    // Boolean flags (--stdin) carry no value; record them as present rather than throwing.
    if (value === undefined || value.startsWith('--')) {
      flags.set(key, '');
      continue;
    }
    flags.set(key, value);
    i++;
  }
  return flags;
}

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
 * A non-secret, comparable identifier for a master key: the first 16 hex chars of its
 * sha256. Lets an operator check that the key written on the offline backup card is the
 * same one production is running without either copy ever being displayed or transmitted.
 * Truncated deliberately — a full hash of a 32-byte key would be a meaningful brute-force
 * target if it ever leaked into a ticket or a chat log.
 */
function keyFingerprint(masterKeyHex: string): string {
  return createHash('sha256').update(masterKeyHex).digest('hex').slice(0, 16);
}

async function readStdin(): Promise<string> {
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
    const key = await readStdin();
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

/**
 * Writes a transactionally consistent copy of the database to `--out`.
 *
 * Uses better-sqlite3's `backup()` (SQLite's online backup API) rather than a file copy.
 * This is not a stylistic preference: the live database runs in WAL mode
 * (`src/persistence/db.ts` sets `journal_mode = WAL`), so committed rows can still be
 * sitting in the `-wal` sidecar file when a copy is taken. Copying `state.db` alone
 * silently drops them — measured at 6 of 500 rows in a WAL-mode reproduction, and the rows
 * it drops are the most recently written ones, i.e. the tenants provisioned last. The
 * backup API reads through the WAL and produces a single self-contained file.
 */
async function cmdSnapshot(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dbPath = resolveDbPath(flags);
  const out = flags.get('out') || `/data/state-backup-${fileTimestamp()}.db`;
  if (out === dbPath) throw new Error('--out must differ from the source database path');
  if (existsSync(out)) {
    throw new Error(`refusing to overwrite an existing file at ${out} — choose another --out`);
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
    const row = check.prepare('SELECT count(*) AS c FROM tenants').get() as { c: number };
    const active = check
      .prepare('SELECT count(*) AS c FROM tenants WHERE disabled = 0')
      .get() as { c: number };
    const integrity = check.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new Error(`snapshot failed integrity_check: ${integrity}`);
    }
    console.log(`Snapshot written: ${out}`);
    console.log(`  integrity_check: ${integrity}`);
    console.log(`  tenants:         ${row.c} (${active.c} active)`);
    console.log(
      '\nThis file contains every tenant robot key as AES-256-GCM ciphertext. It is useless\n' +
        'without FORMA_MASTER_KEY — store the two in different places, or the pair is a\n' +
        'single compromise away from every tenant robot credential.',
    );
  } finally {
    check.close();
  }
}

/**
 * Proves a master key can actually decrypt what is stored — the check that turns "I wrote
 * the key down somewhere" into "I verified the key I wrote down is the right one".
 *
 * Reports per-tenant OK/FAIL and exits non-zero if any row fails. Never prints the key, the
 * decrypted PEM, or any part of either: success is reported as a byte length, which is
 * enough to see that a real PEM came back and not an empty string.
 */
async function cmdVerifyKey(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dbPath = resolveDbPath(flags);
  const masterKey = await resolveMasterKey(flags);

  const db = new Database(dbPath, { readonly: true });
  let failures = 0;
  try {
    const rows = db
      .prepare('SELECT id, name, private_key_ciphertext, disabled FROM tenants ORDER BY created_at')
      .all() as Array<{
      id: string;
      name: string;
      private_key_ciphertext: string;
      disabled: number;
    }>;

    console.log(`Database:        ${dbPath}`);
    console.log(`Key fingerprint: ${keyFingerprint(masterKey)}  (sha256 prefix — not the key)`);
    console.log(`Tenants:         ${rows.length}\n`);

    if (rows.length === 0) {
      console.log('No tenant rows to verify — this proves nothing about the key.');
      return;
    }

    for (const row of rows) {
      const status = row.disabled !== 0 ? '[disabled]' : '[active]  ';
      try {
        const pem = decryptSecret(row.private_key_ciphertext, masterKey);
        if (!pem.includes('PRIVATE KEY')) {
          // Decryption succeeded but the plaintext is not a PEM. GCM's auth tag makes this
          // essentially impossible with a wrong key, so it means the row was written with
          // something other than a private key — worth failing loudly rather than passing.
          failures++;
          console.log(`  FAIL  ${status} ${row.id}  ${row.name} — decrypted, but not a PEM`);
          continue;
        }
        console.log(`  OK    ${status} ${row.id}  ${row.name} (${pem.length} bytes)`);
      } catch (err) {
        failures++;
        console.log(
          `  FAIL  ${status} ${row.id}  ${row.name} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    db.close();
  }

  console.log('');
  if (failures > 0) {
    console.error(
      `${failures} tenant row(s) did not decrypt with this key. Either the key is the wrong\n` +
        'one, or those rows were encrypted under a previous key. Do NOT discard any older\n' +
        'copy of the master key until this reports zero failures.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('All tenant rows decrypt with this key — it is the correct master key.');
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'snapshot':
      await cmdSnapshot(rest);
      break;
    case 'verify-key':
      await cmdVerifyKey(rest);
      break;
    default:
      console.error('Usage: backup-tenants <snapshot|verify-key> [--db <path>] [--out <path>] [--stdin]');
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
