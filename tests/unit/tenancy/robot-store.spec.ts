import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Env } from '../../../src/config/env.js';

// Exercises the real SQLite backend (better-sqlite3), same pattern as
// tests/unit/persistence/cleanup.spec.ts: db.ts reads FORMA_DB_PATH from config/env.js at
// import time, so that module is mocked and everything downstream is re-imported per test.
//
// Requires the better-sqlite3 native binding — see cleanup.spec.ts's note if this suite
// reports a missing binding.

const MASTER_KEY = randomBytes(32).toString('hex');
const CALL_ENV = { FORMA_MASTER_KEY: MASTER_KEY } as unknown as Env;

let dir: string;
let closeDb: (() => void) | undefined;

function dbEnv(dbPath: string): Record<string, unknown> {
  return {
    FORMA_PERSISTENCE_MODE: 'sqlite',
    FORMA_DB_PATH: dbPath,
    FORMA_APPROVAL_TOKEN_TTL: 300,
  };
}

describe('tenancy/robot-store (SQLite)', () => {
  beforeEach(() => {
    vi.resetModules();
    closeDb = undefined;
    dir = mkdtempSync(join(tmpdir(), 'forma-tenants-'));
  });

  afterEach(() => {
    // Windows keeps the file locked while the handle is open, so close before removing.
    closeDb?.();
    rmSync(dir, { recursive: true, force: true });
  });

  async function load(dbPath: string): Promise<{
    createTenant: typeof import('../../../src/tenancy/robot-store.js').createTenant;
    findTenantByBearerKey: typeof import('../../../src/tenancy/robot-store.js').findTenantByBearerKey;
    listTenants: typeof import('../../../src/tenancy/robot-store.js').listTenants;
    disableTenant: typeof import('../../../src/tenancy/robot-store.js').disableTenant;
    getDb: typeof import('../../../src/persistence/db.js').getDb;
  }> {
    vi.doMock('../../../src/config/env.js', () => ({ env: dbEnv(dbPath) }));
    const store = await import('../../../src/tenancy/robot-store.js');
    const db = await import('../../../src/persistence/db.js');
    db._resetDb();
    closeDb = () => {
      db._resetDb();
    };
    return { ...store, getDb: db.getDb };
  }

  const input = {
    name: 'Acme Corp',
    robotEmail: 'robot@acme.example',
    serviceAccountId: 'sa-123',
    keyId: 'key-456',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  };

  it('createTenant → findTenantByBearerKey with the right key returns the tenant', async () => {
    const { createTenant, findTenantByBearerKey } = await load(join(dir, 'state.db'));
    const { tenant, bearerKey } = createTenant(input, CALL_ENV);

    expect(bearerKey.startsWith('fmk_')).toBe(true);
    const found = findTenantByBearerKey(bearerKey, CALL_ENV);
    expect(found?.id).toBe(tenant.id);
    expect(found?.robotEmail).toBe(input.robotEmail);
    expect(found?.serviceAccountId).toBe(input.serviceAccountId);
  });

  it('a wrong bearer key returns null, not a throw', async () => {
    const { createTenant, findTenantByBearerKey } = await load(join(dir, 'state.db'));
    createTenant(input, CALL_ENV);
    expect(findTenantByBearerKey('fmk_totally-wrong-key', CALL_ENV)).toBeNull();
  });

  it('a disabled tenant is not found by its bearer key', async () => {
    const { createTenant, findTenantByBearerKey, disableTenant } = await load(join(dir, 'state.db'));
    const { tenant, bearerKey } = createTenant(input, CALL_ENV);

    expect(findTenantByBearerKey(bearerKey, CALL_ENV)?.id).toBe(tenant.id);
    disableTenant(tenant.id);
    expect(findTenantByBearerKey(bearerKey, CALL_ENV)).toBeNull();
  });

  it('the stored bearer_key_hash column never contains the live bearer key', async () => {
    const { createTenant, getDb } = await load(join(dir, 'state.db'));
    const { bearerKey } = createTenant(input, CALL_ENV);

    const row = getDb()
      .prepare('SELECT bearer_key_hash FROM tenants')
      .get() as { bearer_key_hash: string };
    expect(row.bearer_key_hash).not.toContain(bearerKey);
    expect(row.bearer_key_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, not the raw key
  });

  it('listTenants lists created tenants; disableTenant flips their status', async () => {
    const { createTenant, listTenants, disableTenant } = await load(join(dir, 'state.db'));
    const { tenant } = createTenant(input, CALL_ENV);

    expect(listTenants().map((t) => t.id)).toContain(tenant.id);
    expect(listTenants().find((t) => t.id === tenant.id)?.disabled).toBe(false);

    disableTenant(tenant.id);
    expect(listTenants().find((t) => t.id === tenant.id)?.disabled).toBe(true);
  });

  it('disableTenant throws for an unknown id', async () => {
    const { disableTenant } = await load(join(dir, 'state.db'));
    expect(() => disableTenant('no-such-tenant')).toThrow(/no tenant/);
  });

  it('createTenant throws without FORMA_MASTER_KEY', async () => {
    const { createTenant } = await load(join(dir, 'state.db'));
    const noKeyEnv = {} as unknown as Env;
    expect(() => createTenant(input, noKeyEnv)).toThrow(/FORMA_MASTER_KEY/);
  });
});
