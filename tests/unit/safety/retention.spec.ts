import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../../src/config/env.js';

vi.mock('../../../src/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const AUDIT_DIR = '/tmp/test-audit';
const BASE_ENV = {
  APS_AUTH_MODE: 'ssa',
  SSA_ID: 'test-ssa',
  APS_REGION: 'US',
  FORMA_AUDIT_DIR: AUDIT_DIR,
  FORMA_AUDIT_INCLUDE_READS: true,
  FORMA_AUDIT_FAIL_CLOSED: false,
  FORMA_AUDIT_RETENTION_DAYS: 30,
  FORMA_AUDIT_INDEX: 'none',
  FORMA_ALLOWED_HUBS: '*',
  FORMA_ALLOWED_PROJECTS: '*',
  FORMA_MUTATION_MODE: 'preview_required',
  FORMA_READONLY: false,
  FORMA_APPROVAL_TOKEN_TTL: 300,
} as unknown as Env;

const mockUnlinkSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockExistsSync = vi.fn(() => true);

// Real readdirSync(dir, {withFileTypes:true}) returns Dirent objects; pruneOldAuditFiles
// uses that to tell files from tenant subdirectories apart, so the mock must too.
function fileEntry(name: string): Dirent {
  return { name, isFile: () => true, isDirectory: () => false } as unknown as Dirent;
}
function dirEntry(name: string): Dirent {
  return { name, isFile: () => false, isDirectory: () => true } as unknown as Dirent;
}

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: mockExistsSync,
  readFileSync: vi.fn(() => ''),
  readdirSync: mockReaddirSync,
  unlinkSync: mockUnlinkSync,
}));

describe('pruneOldAuditFiles', () => {
  let pruneOldAuditFiles: typeof import('../../../src/safety/audit-log.js').pruneOldAuditFiles;

  beforeEach(async () => {
    vi.resetModules();
    mockUnlinkSync.mockReset();
    mockReaddirSync.mockReset();
    mockExistsSync.mockReturnValue(true);

    const mod = await import('../../../src/safety/audit-log.js');
    pruneOldAuditFiles = mod.pruneOldAuditFiles;
  });

  it('deletes files older than retention window', () => {
    // retention = 30 days. Files 31+ days old should be deleted.
    const old1 = 'audit-2020-01-01.jsonl';
    const old2 = 'audit-2019-06-15.jsonl';
    const recent = `audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    mockReaddirSync.mockReturnValue([
      fileEntry(old1),
      fileEntry(old2),
      fileEntry(recent),
      fileEntry('not-an-audit-file.txt'),
    ]);

    pruneOldAuditFiles(BASE_ENV);

    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
    const deletedFiles = mockUnlinkSync.mock.calls.map((c) => String(c[0]));
    expect(deletedFiles.some((p) => p.includes(old1))).toBe(true);
    expect(deletedFiles.some((p) => p.includes(old2))).toBe(true);
    expect(deletedFiles.some((p) => p.includes(recent))).toBe(false);
  });

  it('does not delete files within the retention window', () => {
    const today = new Date();
    // 10 days ago — within 30-day window
    const recent = new Date(today);
    recent.setUTCDate(recent.getUTCDate() - 10);
    const recentFile = `audit-${recent.toISOString().slice(0, 10)}.jsonl`;
    mockReaddirSync.mockReturnValue([fileEntry(recentFile)]);

    pruneOldAuditFiles(BASE_ENV);

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('skips non-audit filenames', () => {
    mockReaddirSync.mockReturnValue([
      fileEntry('state.db'),
      fileEntry('some-log.txt'),
      fileEntry('audit-baddate.jsonl'), // malformed date
      fileEntry('audit-2020-01-01.json'), // wrong extension
    ]);

    pruneOldAuditFiles(BASE_ENV);

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('is a no-op when audit dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    pruneOldAuditFiles(BASE_ENV);

    expect(mockReaddirSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('continues pruning when one unlink fails', () => {
    const old1 = 'audit-2020-01-01.jsonl';
    const old2 = 'audit-2020-02-01.jsonl';
    mockReaddirSync.mockReturnValue([fileEntry(old1), fileEntry(old2)]);
    mockUnlinkSync.mockImplementationOnce(() => { throw new Error('permission denied'); });

    // Should not throw even if first unlink fails
    expect(() => pruneOldAuditFiles(BASE_ENV)).not.toThrow();
    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
  });

  it('prunes expired files inside a one-level-deep tenant subdirectory too', () => {
    const oldRoot = 'audit-2020-01-01.jsonl';
    const oldTenant = 'audit-2020-03-01.jsonl';

    const tenantDir = join(AUDIT_DIR, 'tenant-a');
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === AUDIT_DIR) return [fileEntry(oldRoot), dirEntry('tenant-a')];
      if (dir === tenantDir) return [oldTenant]; // plain readdirSync (no withFileTypes) returns string[]
      return [];
    });

    pruneOldAuditFiles(BASE_ENV);

    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
    const deletedFiles = mockUnlinkSync.mock.calls.map((c) => String(c[0]));
    expect(deletedFiles.some((p) => p.includes(oldRoot))).toBe(true);
    expect(deletedFiles.some((p) => p.includes('tenant-a') && p.includes(oldTenant))).toBe(true);
  });
});
