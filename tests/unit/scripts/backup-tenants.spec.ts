import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { encryptSecret } from '../../../src/tenancy/crypto.js';

/**
 * scripts/backup-tenants.ts is a CLI whose contract IS its exit code and stdout — the
 * runbook (docs/runbooks/RUNBOOK_backup-and-restore.md) tells an operator to read both.
 * So these drive the real process rather than importing functions out of it.
 *
 * tsx is invoked directly from node_modules/.bin rather than through `npx` — measured at
 * ~0.1s per call, cheap enough to keep the whole file well inside the suite's budget.
 */
const CLI = 'scripts/backup-tenants.ts';
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');

const MASTER_KEY = randomBytes(32).toString('hex');
const WRONG_KEY = randomBytes(32).toString('hex');

// A recognizable stand-in for a robot private key: verify-key checks for the PEM marker,
// and the body is what must never appear in CLI output.
const PEM_BODY = 'super-secret-robot-key-material';
const FAKE_PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;

function run(args: string[], stdin?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf8',
    input: stdin ?? '',
    // Keep the ambient FORMA_MASTER_KEY (a developer's own .env export) out of the child,
    // or the "no key available" case would silently pass for the wrong reason.
    env: { ...process.env, FORMA_MASTER_KEY: '' },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Builds a WAL-mode database matching the live `tenants` schema and deliberately leaves the
 * writes uncheckpointed — the connection stays open, so the rows are still in the -wal
 * sidecar. That is the state a backup has to survive.
 */
function seedDb(path: string, tenantCount: number, key = MASTER_KEY): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE tenants (
      id                     TEXT    PRIMARY KEY,
      name                   TEXT    NOT NULL,
      robot_email            TEXT    NOT NULL,
      service_account_id     TEXT    NOT NULL,
      key_id                 TEXT    NOT NULL,
      private_key_ciphertext TEXT    NOT NULL,
      bearer_key_hash        TEXT    NOT NULL UNIQUE,
      created_at             TEXT    NOT NULL,
      disabled               INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(
    'INSERT INTO tenants VALUES (@id, @name, @email, @sa, @kid, @ct, @hash, @created, @disabled)',
  );
  for (let i = 0; i < tenantCount; i++) {
    insert.run({
      id: `tenant-${i}`,
      name: `Customer ${i}`,
      email: `robot${i}@example.autodesk.com`,
      sa: `sa-${i}`,
      kid: `kid-${i}`,
      ct: encryptSecret(FAKE_PEM, key),
      hash: randomBytes(32).toString('hex'),
      created: new Date(Date.now() + i).toISOString(),
      disabled: i % 3 === 0 ? 1 : 0,
    });
  }
  return db;
}

describe('scripts/backup-tenants', () => {
  let dir: string;
  let dbPath: string;
  let live: Database.Database | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forma-backup-'));
    dbPath = join(dir, 'state.db');
  });

  afterEach(() => {
    live?.close();
    live = null;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('snapshot', () => {
    it('captures rows still sitting in the WAL that a raw file copy loses', () => {
      live = seedDb(dbPath, 400);

      // What `cp /data/state.db` does: copy the main file, leave the -wal behind.
      const naive = join(dir, 'naive-copy.db');
      copyFileSync(dbPath, naive);

      const out = join(dir, 'snapshot.db');
      const result = run(['snapshot', '--db', dbPath, '--out', out]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('integrity_check: ok');

      const fromSnapshot = new Database(out, { readonly: true });
      const snapshotRows = fromSnapshot.prepare('SELECT count(*) AS c FROM tenants').get() as {
        c: number;
      };
      fromSnapshot.close();
      expect(snapshotRows.c).toBe(400);

      // The naive copy is not merely short a few rows — with the CREATE TABLE itself still
      // in the WAL it has no `tenants` table at all. Asserted as "does not equal 400" so the
      // test states the property (a file copy is not a backup) rather than pinning one
      // particular SQLite checkpointing outcome.
      let naiveRows = -1;
      try {
        const fromNaive = new Database(naive, { readonly: true });
        naiveRows = (fromNaive.prepare('SELECT count(*) AS c FROM tenants').get() as { c: number })
          .c;
        fromNaive.close();
      } catch {
        naiveRows = -1; // unreadable — the strongest form of the same failure
      }
      expect(naiveRows).not.toBe(400);
    });

    it('reports the tenant count and how many are active', () => {
      live = seedDb(dbPath, 6); // ids 0 and 3 are disabled (i % 3 === 0)
      const out = join(dir, 'snapshot.db');
      const result = run(['snapshot', '--db', dbPath, '--out', out]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('tenants:         6 (4 active)');
    });

    it('refuses to overwrite an existing file', () => {
      live = seedDb(dbPath, 2);
      const out = join(dir, 'snapshot.db');
      expect(run(['snapshot', '--db', dbPath, '--out', out]).status).toBe(0);

      const second = run(['snapshot', '--db', dbPath, '--out', out]);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('refusing to overwrite');
    });

    it('refuses to write the snapshot over its own source', () => {
      live = seedDb(dbPath, 2);
      const result = run(['snapshot', '--db', dbPath, '--out', dbPath]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must differ from the source');
    });

    it('does not mutate the source database', () => {
      live = seedDb(dbPath, 5);
      const before = (
        live.prepare('SELECT count(*) AS c FROM tenants').get() as { c: number }
      ).c;

      expect(run(['snapshot', '--db', dbPath, '--out', join(dir, 'snap.db')]).status).toBe(0);

      const after = (live.prepare('SELECT count(*) AS c FROM tenants').get() as { c: number }).c;
      expect(after).toBe(before);
      // getDb()'s migrateSchema() would have created these; a readonly backup must not.
      const tables = live
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(['tenants']);
    });
  });

  describe('verify-key', () => {
    it('exits 0 and confirms every row when given the correct key', () => {
      live = seedDb(dbPath, 4);
      const result = run(['verify-key', '--db', dbPath, '--stdin'], MASTER_KEY);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('All tenant rows decrypt with this key');
      expect(result.stdout).not.toContain('FAIL');
    });

    it('exits 1 and names every failing row when given the wrong key', () => {
      live = seedDb(dbPath, 3);
      const result = run(['verify-key', '--db', dbPath, '--stdin'], WRONG_KEY);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL');
      expect(result.stderr).toContain('did not decrypt with this key');
    });

    it('never prints the master key or the decrypted PEM body', () => {
      live = seedDb(dbPath, 3);
      const ok = run(['verify-key', '--db', dbPath, '--stdin'], MASTER_KEY);
      const combined = ok.stdout + ok.stderr;
      expect(combined).not.toContain(MASTER_KEY);
      expect(combined).not.toContain(PEM_BODY);
      expect(combined).not.toContain('BEGIN PRIVATE KEY');
    });

    it('prints a key fingerprint that is stable for one key and differs across keys', () => {
      live = seedDb(dbPath, 1);
      const fingerprint = (out: string): string => {
        const match = /Key fingerprint: ([0-9a-f]+)/.exec(out);
        return match?.[1] ?? '';
      };

      const first = fingerprint(run(['verify-key', '--db', dbPath, '--stdin'], MASTER_KEY).stdout);
      const again = fingerprint(run(['verify-key', '--db', dbPath, '--stdin'], MASTER_KEY).stdout);
      const other = fingerprint(run(['verify-key', '--db', dbPath, '--stdin'], WRONG_KEY).stdout);

      expect(first).toHaveLength(16);
      expect(again).toBe(first);
      expect(other).not.toBe(first);
      // The fingerprint must not be a prefix of the key itself.
      expect(MASTER_KEY.startsWith(first)).toBe(false);
    });

    it('reads the key from FORMA_MASTER_KEY when --stdin is not passed', () => {
      live = seedDb(dbPath, 2);
      const result = spawnSync(TSX, [CLI, 'verify-key', '--db', dbPath], {
        encoding: 'utf8',
        env: { ...process.env, FORMA_MASTER_KEY: MASTER_KEY },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('All tenant rows decrypt with this key');
    });

    it('fails clearly when no key is available from either source', () => {
      live = seedDb(dbPath, 1);
      const result = run(['verify-key', '--db', dbPath]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no master key available');
    });

    it('says so rather than claiming success when there are no tenant rows', () => {
      live = seedDb(dbPath, 0);
      const result = run(['verify-key', '--db', dbPath, '--stdin'], MASTER_KEY);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('proves nothing about the key');
      expect(result.stdout).not.toContain('All tenant rows decrypt');
    });

    it('verifies a snapshot artifact, not just the live database', () => {
      live = seedDb(dbPath, 3);
      const out = join(dir, 'snapshot.db');
      expect(run(['snapshot', '--db', dbPath, '--out', out]).status).toBe(0);
      expect(existsSync(out)).toBe(true);

      // The runbook's disaster drill: prove the pulled copy decrypts with the offline key.
      const result = run(['verify-key', '--db', out, '--stdin'], MASTER_KEY);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('All tenant rows decrypt with this key');
    });
  });

  it('reports a usable error for a database path that does not exist', () => {
    const result = run(['verify-key', '--db', join(dir, 'absent.db'), '--stdin'], MASTER_KEY);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no database at');
  });

  it('exits non-zero with usage for an unknown command', () => {
    const result = run(['frobnicate']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: backup-tenants');
  });
});
