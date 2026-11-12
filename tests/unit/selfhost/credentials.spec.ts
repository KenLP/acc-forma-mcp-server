import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSsaCredentials } from '../../../src/selfhost/credentials.js';
import { writeRobotFiles, clientIdPrefix, ROBOT_KEY_FILE } from '../../../src/selfhost/robot-file.js';

const CLIENT_ID = 'AbCdEfGh12345678';

// SPEC_self-host-installer §2.1 — all three branches, plus the precedence rule that the
// original SSA_* env path always wins over a robot in the data folder.
describe('selfhost/credentials — resolveSsaCredentials', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bimlynx-cred-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRobot(prefix = clientIdPrefix(CLIENT_ID)): void {
    writeRobotFiles(
      dir,
      { serviceAccountId: 'SA1', email: 'r@x.com', keyId: 'kid', createdAt: 'now', clientIdPrefix: prefix },
      'PEM',
    );
  }

  it('(1) env SSA_* wins even when the data folder holds a valid robot', () => {
    writeRobot();
    expect(
      resolveSsaCredentials({
        APS_CLIENT_ID: CLIENT_ID,
        SSA_ID: 'env-sa',
        SSA_KEY_ID: 'env-kid',
        SSA_KEY_PATH: '/env/key.pem',
        BIMLYNX_DATA_DIR: dir,
      }),
    ).toEqual({ source: 'env' });
  });

  it('(1) any SSA_* var counts as the env path (partial sets are rejected by config/env)', () => {
    expect(resolveSsaCredentials({ APS_CLIENT_ID: CLIENT_ID, SSA_ID: 'x', BIMLYNX_DATA_DIR: dir })).toEqual({
      source: 'env',
    });
  });

  it('(2) uses the robot from the data folder when no SSA_* var is set', () => {
    writeRobot();
    expect(resolveSsaCredentials({ APS_CLIENT_ID: CLIENT_ID, BIMLYNX_DATA_DIR: dir })).toEqual({
      source: 'robot-file',
      dataDir: dir,
      ssaId: 'SA1',
      ssaKeyId: 'kid',
      ssaKeyPath: join(dir, ROBOT_KEY_FILE),
      email: 'r@x.com',
    });
  });

  it('(3) setup mode when the data folder has no robot', () => {
    expect(resolveSsaCredentials({ APS_CLIENT_ID: CLIENT_ID, BIMLYNX_DATA_DIR: dir })).toEqual({
      source: 'setup',
      dataDir: dir,
    });
  });

  it('(3) setup mode with the reason when the robot belongs to another app', () => {
    writeRobot('ZZZZZZZZ');
    const result = resolveSsaCredentials({ APS_CLIENT_ID: CLIENT_ID, BIMLYNX_DATA_DIR: dir });
    expect(result.source).toBe('setup');
    expect(result.source === 'setup' && result.problem).toMatch(/different APS app/);
  });

  it('throws with neither SSA_* nor a data folder', () => {
    expect(() => resolveSsaCredentials({ APS_CLIENT_ID: CLIENT_ID })).toThrow(/BIMLYNX_DATA_DIR/);
  });
});
