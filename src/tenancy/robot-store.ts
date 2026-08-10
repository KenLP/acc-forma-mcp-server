import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { getDb } from '../persistence/db.js';
import { encryptSecret } from './crypto.js';
import type { TenantRecord } from './types.js';
import type { Env } from '../config/env.js';

// No config/env.js value import here — Env is a type-only import (erased at compile time),
// every runtime env value arrives as an explicit `env` parameter. See crypto.ts header.

/**
 * Tenant rows are ALWAYS durable SQLite via getDb(), independent of FORMA_PERSISTENCE_MODE
 * (which only governs approval tokens / rate counters / idempotency records — short-lived
 * operational state where losing a row on restart is a minor inconvenience). A tenant row
 * IS the credential that lets a customer's robot authenticate at all; losing it silently on
 * restart would be a customer-visible outage, so it does not follow the memory-by-default
 * policy the other three stores use.
 */

interface TenantRow {
  id: string;
  name: string;
  robot_email: string;
  service_account_id: string;
  key_id: string;
  private_key_ciphertext: string;
  bearer_key_hash: string;
  created_at: string;
  disabled: number;
}

function rowToRecord(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    name: row.name,
    robotEmail: row.robot_email,
    serviceAccountId: row.service_account_id,
    keyId: row.key_id,
    privateKeyCiphertext: row.private_key_ciphertext,
    bearerKeyHash: row.bearer_key_hash,
    createdAt: row.created_at,
    disabled: row.disabled !== 0,
  };
}

export interface CreateTenantInput {
  name: string;
  robotEmail: string;
  serviceAccountId: string;
  keyId: string;
  /** RS256 private key PEM content (not a path) — encrypted before it touches disk. */
  privateKeyPem: string;
}

/**
 * Provisions a new tenant. Returns the bearer key in plaintext — this is the ONLY time it
 * is ever available; only its sha256 hash is persisted (mirrors the approval-token
 * fingerprinting rule in CLAUDE.md's Key Invariants).
 */
export function createTenant(
  input: CreateTenantInput,
  env: Env,
): { tenant: TenantRecord; bearerKey: string } {
  if (!env.FORMA_MASTER_KEY) {
    throw new Error(
      'createTenant: FORMA_MASTER_KEY is required to encrypt the tenant robot private key at rest.',
    );
  }

  const db = getDb();
  const id = randomUUID();
  const bearerKey = `fmk_${randomBytes(32).toString('base64url')}`;
  const bearerKeyHash = createHash('sha256').update(bearerKey).digest('hex');
  const privateKeyCiphertext = encryptSecret(input.privateKeyPem, env.FORMA_MASTER_KEY);
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO tenants
       (id, name, robot_email, service_account_id, key_id, private_key_ciphertext, bearer_key_hash, created_at, disabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    input.name,
    input.robotEmail,
    input.serviceAccountId,
    input.keyId,
    privateKeyCiphertext,
    bearerKeyHash,
    createdAt,
  );

  return {
    tenant: {
      id,
      name: input.name,
      robotEmail: input.robotEmail,
      serviceAccountId: input.serviceAccountId,
      keyId: input.keyId,
      privateKeyCiphertext,
      bearerKeyHash,
      createdAt,
      disabled: false,
    },
    bearerKey,
  };
}

/**
 * Looks up a tenant by its live bearer key (hashed before the query — the live key is
 * never stored). Returns null for an unknown key or a disabled tenant; never throws on a
 * bad key so callers (the HTTP transport) can map a miss straight to 401.
 *
 * `env` is accepted for signature symmetry with the rest of this module (callers pass the
 * same baseEnv they already have on hand) — this lookup itself needs no env value.
 */
export function findTenantByBearerKey(bearerKey: string, _env: Env): TenantRecord | null {
  const db = getDb();
  const hash = createHash('sha256').update(bearerKey).digest('hex');
  const row = db
    .prepare('SELECT * FROM tenants WHERE bearer_key_hash = ? AND disabled = 0')
    .get(hash) as TenantRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function listTenants(): TenantRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM tenants ORDER BY created_at').all() as TenantRow[];
  return rows.map(rowToRecord);
}

export function disableTenant(id: string): void {
  const db = getDb();
  const result = db.prepare('UPDATE tenants SET disabled = 1 WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new Error(`disableTenant: no tenant with id ${id}`);
  }
}
