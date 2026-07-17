import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// config/env.ts calls dotenvConfig() at import time, which would pull real
// values from the repo's local .env (present in dev, absent in CI) into
// process.env before our per-test overrides are read. Stub it out so every
// test controls process.env deterministically regardless of machine.
vi.mock('dotenv', () => ({ config: vi.fn() }));

// Fields config/env.ts requires unconditionally (or for APS_AUTH_MODE=ssa,
// the mode every other test in this repo uses) — set so loadEnv() only fails
// for the numeric-field reason each test is actually checking.
const REQUIRED_ENV: Record<string, string> = {
  APS_CLIENT_ID: 'test-client-id',
  APS_CLIENT_SECRET: 'test-client-secret',
  APS_AUTH_MODE: 'ssa',
  SSA_ID: 'test-ssa-id',
  SSA_KEY_ID: 'test-key-id',
  SSA_KEY_PATH: '/tmp/test-key.pem',
};

// The two fields under test (F8) — deleted before each test so a bad/missing
// value in the real environment can't leak in; each test sets what it needs.
const UNDER_TEST_KEYS = ['FORMA_APPROVAL_TOKEN_TTL', 'FORMA_AUDIT_RETENTION_DAYS'];
const ALL_KEYS = [...Object.keys(REQUIRED_ENV), ...UNDER_TEST_KEYS];

describe('config/env — numeric config validation (F8)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of ALL_KEYS) saved[key] = process.env[key];
    for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
    for (const key of UNDER_TEST_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('rejects a non-numeric FORMA_APPROVAL_TOKEN_TTL', async () => {
    process.env.FORMA_APPROVAL_TOKEN_TTL = 'abc';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(
      /FORMA_APPROVAL_TOKEN_TTL/,
    );
  });

  it('rejects FORMA_APPROVAL_TOKEN_TTL=0 (would never expire tokens)', async () => {
    process.env.FORMA_APPROVAL_TOKEN_TTL = '0';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(
      /FORMA_APPROVAL_TOKEN_TTL/,
    );
  });

  it('rejects a negative FORMA_APPROVAL_TOKEN_TTL', async () => {
    process.env.FORMA_APPROVAL_TOKEN_TTL = '-5';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(
      /FORMA_APPROVAL_TOKEN_TTL/,
    );
  });

  it('accepts a valid FORMA_APPROVAL_TOKEN_TTL and coerces it to a number', async () => {
    process.env.FORMA_APPROVAL_TOKEN_TTL = '300';
    const { env } = await import('../../../src/config/env.js');
    expect(env.FORMA_APPROVAL_TOKEN_TTL).toBe(300);
    expect(typeof env.FORMA_APPROVAL_TOKEN_TTL).toBe('number');
  });

  it('rejects a non-numeric FORMA_AUDIT_RETENTION_DAYS', async () => {
    process.env.FORMA_AUDIT_RETENTION_DAYS = 'abc';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(
      /FORMA_AUDIT_RETENTION_DAYS/,
    );
  });

  it('falls back to the documented defaults (300 / 90) when neither var is set', async () => {
    // UNDER_TEST_KEYS already deleted in beforeEach — nothing to do here.
    const { env } = await import('../../../src/config/env.js');
    expect(env.FORMA_APPROVAL_TOKEN_TTL).toBe(300);
    expect(env.FORMA_AUDIT_RETENTION_DAYS).toBe(90);
  });
});
