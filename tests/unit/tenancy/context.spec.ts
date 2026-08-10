import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../../../src/tenancy/crypto.js';
import { buildTenantContext, _resetTenantContextCache } from '../../../src/tenancy/context.js';
import type { TenantRecord } from '../../../src/tenancy/types.js';
import type { Env } from '../../../src/config/env.js';

const MASTER_KEY = randomBytes(32).toString('hex');
const PEM = '-----BEGIN PRIVATE KEY-----\nfake-robot-key\n-----END PRIVATE KEY-----';

function makeTenant(id: string, overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id,
    name: `Tenant ${id}`,
    robotEmail: `robot-${id}@example.com`,
    serviceAccountId: `sa-${id}`,
    keyId: `key-${id}`,
    privateKeyCiphertext: encryptSecret(PEM, MASTER_KEY),
    bearerKeyHash: 'irrelevant-to-this-suite',
    createdAt: new Date().toISOString(),
    disabled: false,
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APS_CLIENT_ID: 'publisher-client-id',
    APS_CLIENT_SECRET: 'publisher-client-secret',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_DIR: '/tmp/forma-audit-root',
    FORMA_MASTER_KEY: MASTER_KEY,
    ...overrides,
  } as unknown as Env;
}

describe('tenancy/context — buildTenantContext', () => {
  beforeEach(() => {
    _resetTenantContextCache();
  });

  it('overrides FORMA_AUDIT_DIR to a per-tenant subdirectory and sets tenantId', () => {
    const ctx = buildTenantContext(makeTenant('t1'), makeEnv());
    expect(ctx.tenantId).toBe('t1');
    // Normalize separators — join() on Windows uses backslashes.
    expect(ctx.env.FORMA_AUDIT_DIR.replace(/\\/g, '/')).toBe('/tmp/forma-audit-root/t1');
  });

  it('overrides ctx.env.SSA_ID to the tenant\'s own robot service-account id, not the process env', () => {
    const tenant = makeTenant('t1', { serviceAccountId: 'sa-t1-robot' });
    const ctx = buildTenantContext(tenant, makeEnv({ SSA_ID: 'process-wide-ssa-id' }));
    expect(ctx.env.SSA_ID).toBe('sa-t1-robot');
  });

  it('gives different tenants different ctx.env.SSA_ID values', () => {
    const ctxA = buildTenantContext(makeTenant('t1', { serviceAccountId: 'sa-t1' }), makeEnv());
    const ctxB = buildTenantContext(makeTenant('t2', { serviceAccountId: 'sa-t2' }), makeEnv());
    expect(ctxA.env.SSA_ID).toBe('sa-t1');
    expect(ctxB.env.SSA_ID).toBe('sa-t2');
    expect(ctxA.env.SSA_ID).not.toBe(ctxB.env.SSA_ID);
  });

  it('does not mutate the baseEnv object passed in', () => {
    const base = makeEnv();
    buildTenantContext(makeTenant('t1'), base);
    expect(base.FORMA_AUDIT_DIR).toBe('/tmp/forma-audit-root');
  });

  it('attaches no auth2lo — 2-legged auth would see the whole hub, breaking tenant isolation', () => {
    const ctx = buildTenantContext(makeTenant('t1'), makeEnv());
    expect(ctx.auth2lo).toBeUndefined();
  });

  it('caches the same SsaAuthProvider instance across calls for the same tenant', () => {
    const tenant = makeTenant('t1');
    const ctx1 = buildTenantContext(tenant, makeEnv());
    const ctx2 = buildTenantContext(tenant, makeEnv());
    expect(ctx1.auth).toBe(ctx2.auth);
  });

  it('gives different tenants different provider instances', () => {
    const ctx1 = buildTenantContext(makeTenant('t1'), makeEnv());
    const ctx2 = buildTenantContext(makeTenant('t2'), makeEnv());
    expect(ctx1.auth).not.toBe(ctx2.auth);
  });

  it('decrypts the tenant private key correctly (round-trips through crypto.ts)', () => {
    // buildTenantContext doesn't expose the decrypted key itself (it goes straight into
    // SsaAuthProvider), so verify the same ciphertext independently through crypto.ts —
    // this is the exact value buildTenantContext feeds to decryptSecret internally.
    const tenant = makeTenant('t1');
    expect(decryptSecret(tenant.privateKeyCiphertext, MASTER_KEY)).toBe(PEM);
    // And confirm building the context with that same key succeeds without throwing.
    expect(() => buildTenantContext(tenant, makeEnv())).not.toThrow();
  });

  it('throws when FORMA_MASTER_KEY is missing from baseEnv', () => {
    expect(() =>
      buildTenantContext(makeTenant('t1'), makeEnv({ FORMA_MASTER_KEY: undefined })),
    ).toThrow(/FORMA_MASTER_KEY/);
  });

  it('throws when the private key cannot be decrypted with the given master key', () => {
    const tenant = makeTenant('t1');
    const wrongKeyEnv = makeEnv({ FORMA_MASTER_KEY: randomBytes(32).toString('hex') });
    expect(() => buildTenantContext(tenant, wrongKeyEnv)).toThrow();
  });
});
