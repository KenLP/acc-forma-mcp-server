import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Same isolation as env-validation.spec.ts: never let the repo's real .env leak in.
vi.mock('dotenv', () => ({ config: vi.fn() }));

const KEYS = [
  'APS_CLIENT_ID',
  'APS_CLIENT_SECRET',
  'APS_AUTH_MODE',
  'FORMA_TRANSPORT',
  'SSA_ID',
  'SSA_KEY_ID',
  'SSA_KEY_PATH',
  'BIMLYNX_DATA_DIR',
  'FORMA_AUDIT_DIR',
];

describe('config/env — self-host BIMLYNX_DATA_DIR', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.APS_CLIENT_ID = 'test-client-id';
    process.env.APS_CLIENT_SECRET = 'test-client-secret';
    process.env.APS_AUTH_MODE = 'ssa';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('still refuses to start with no SSA_* and no data folder (unchanged behavior)', async () => {
    await expect(import('../../../src/config/env.js')).rejects.toThrow(
      /APS_AUTH_MODE=ssa requires SSA_ID, SSA_KEY_ID, SSA_KEY_PATH/,
    );
  });

  it('still refuses a partial SSA_* set even with a data folder', async () => {
    process.env.SSA_ID = 'sa';
    process.env.BIMLYNX_DATA_DIR = '/tmp/bimlynx';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(/SSA_KEY_ID, SSA_KEY_PATH/);
  });

  it('starts (setup mode) with no SSA_* when a data folder is set, auditing under it', async () => {
    process.env.BIMLYNX_DATA_DIR = '/tmp/bimlynx';
    const { env } = await import('../../../src/config/env.js');
    expect(env.BIMLYNX_DATA_DIR).toBe(resolve('/tmp/bimlynx'));
    expect(env.FORMA_AUDIT_DIR).toBe(join(resolve('/tmp/bimlynx'), 'audit'));
  });

  it('keeps an explicit FORMA_AUDIT_DIR', async () => {
    process.env.BIMLYNX_DATA_DIR = '/tmp/bimlynx';
    process.env.FORMA_AUDIT_DIR = '/var/audit';
    const { env } = await import('../../../src/config/env.js');
    expect(env.FORMA_AUDIT_DIR).toBe('/var/audit');
  });

  it('expands ${HOME} and ~ in case the client passes the manifest default through', async () => {
    process.env.BIMLYNX_DATA_DIR = '${HOME}/BIMLynx';
    let { env } = await import('../../../src/config/env.js');
    expect(env.BIMLYNX_DATA_DIR).toBe(resolve(homedir(), 'BIMLynx'));

    vi.resetModules();
    process.env.BIMLYNX_DATA_DIR = '~/BIMLynx';
    ({ env } = await import('../../../src/config/env.js'));
    expect(env.BIMLYNX_DATA_DIR).toBe(resolve(homedir(), 'BIMLynx'));
  });

  it('leaves the data folder unset when the env var is blank', async () => {
    process.env.SSA_ID = 'sa';
    process.env.SSA_KEY_ID = 'kid';
    process.env.SSA_KEY_PATH = '/k.pem';
    process.env.BIMLYNX_DATA_DIR = '  ';
    const { env } = await import('../../../src/config/env.js');
    expect(env.BIMLYNX_DATA_DIR).toBeUndefined();
  });
});
