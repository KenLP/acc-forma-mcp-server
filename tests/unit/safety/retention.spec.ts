import { describe, it, expect, vi, beforeEach } from 'vitest';

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
};

vi.mock('../../../src/config/env.js', () => ({ env: BASE_ENV }));

const mockUnlinkSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockExistsSync = vi.fn(() => true);

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
    mockReaddirSync.mockReturnValue([old1, old2, recent, 'not-an-audit-file.txt']);

    pruneOldAuditFiles();

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
    mockReaddirSync.mockReturnValue([recentFile]);

    pruneOldAuditFiles();

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('skips non-audit filenames', () => {
    mockReaddirSync.mockReturnValue([
      'state.db',
      'some-log.txt',
      'audit-baddate.jsonl',       // malformed date
      'audit-2020-01-01.json',     // wrong extension
    ]);

    pruneOldAuditFiles();

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('is a no-op when audit dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    pruneOldAuditFiles();

    expect(mockReaddirSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('continues pruning when one unlink fails', () => {
    const old1 = 'audit-2020-01-01.jsonl';
    const old2 = 'audit-2020-02-01.jsonl';
    mockReaddirSync.mockReturnValue([old1, old2]);
    mockUnlinkSync.mockImplementationOnce(() => { throw new Error('permission denied'); });

    // Should not throw even if first unlink fails
    expect(() => pruneOldAuditFiles()).not.toThrow();
    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
  });
});
