import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRobotFile,
  writeRobotFiles,
  clientIdPrefix,
  ROBOT_FILE,
  ROBOT_KEY_FILE,
} from '../../../src/selfhost/robot-file.js';
import type { RobotRecord } from '../../../src/selfhost/robot-file.js';

const CLIENT_ID = 'AbCdEfGh12345678';
const PEM = '-----BEGIN PRIVATE KEY-----\nTESTKEY\n-----END PRIVATE KEY-----\n';

function record(overrides: Partial<RobotRecord> = {}): RobotRecord {
  return {
    serviceAccountId: 'SA123',
    email: 'bimlynx-pc@abcdefgh.adskserviceaccount.autodesk.com',
    keyId: 'kid-1',
    createdAt: '2026-10-27T00:00:00.000Z',
    clientIdPrefix: clientIdPrefix(CLIENT_ID),
    ...overrides,
  };
}

describe('selfhost/robot-file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bimlynx-robot-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports absent for an empty or missing folder', () => {
    expect(readRobotFile(dir, CLIENT_ID)).toEqual({ status: 'absent' });
    expect(readRobotFile(join(dir, 'does-not-exist'), CLIENT_ID)).toEqual({ status: 'absent' });
  });

  it('round-trips a written robot, creating the folder', () => {
    const nested = join(dir, 'BIMLynx');
    writeRobotFiles(nested, record(), PEM);
    const state = readRobotFile(nested, CLIENT_ID);
    expect(state.status).toBe('ok');
    if (state.status !== 'ok') return;
    expect(state.record).toEqual(record());
    expect(state.keyPath).toBe(join(nested, ROBOT_KEY_FILE));
    expect(readFileSync(state.keyPath, 'utf-8')).toBe(PEM);
    // The record never carries key material.
    expect(readFileSync(join(nested, ROBOT_FILE), 'utf-8')).not.toContain('PRIVATE KEY');
  });

  it('refuses to overwrite an existing robot', () => {
    writeRobotFiles(dir, record(), PEM);
    expect(() => writeRobotFiles(dir, record({ serviceAccountId: 'SA999' }), PEM)).toThrow();
    const state = readRobotFile(dir, CLIENT_ID);
    expect(state.status === 'ok' && state.record.serviceAccountId).toBe('SA123');
  });

  it('flags a robot created under a different Client ID', () => {
    writeRobotFiles(dir, record({ clientIdPrefix: 'ZZZZZZZZ' }), PEM);
    const state = readRobotFile(dir, CLIENT_ID);
    expect(state.status).toBe('invalid');
    expect(state.status === 'invalid' && state.reason).toMatch(/different APS app/);
  });

  it('flags malformed JSON, missing fields and a missing key', () => {
    writeFileSync(join(dir, ROBOT_FILE), '{not json');
    expect(readRobotFile(dir, CLIENT_ID).status).toBe('invalid');

    writeFileSync(join(dir, ROBOT_FILE), JSON.stringify({ serviceAccountId: 'SA1' }));
    const missingFields = readRobotFile(dir, CLIENT_ID);
    expect(missingFields.status === 'invalid' && missingFields.reason).toMatch(/missing required fields/);

    writeFileSync(join(dir, ROBOT_FILE), JSON.stringify(record()));
    expect(existsSync(join(dir, ROBOT_KEY_FILE))).toBe(false);
    const missingKey = readRobotFile(dir, CLIENT_ID);
    expect(missingKey.status === 'invalid' && missingKey.reason).toMatch(/private key/);
  });
});
