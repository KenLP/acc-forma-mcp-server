import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/env.js', () => ({
  env: {
    APS_AUTH_MODE: 'ssa',
    SSA_ID: 'test-ssa',
    APS_REGION: 'US',
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_APPROVAL_TOKEN_TTL: 300,
  },
}));

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

describe('audit-log', () => {
  let appendAuditEntry: typeof import('../../../src/safety/audit-log.js').appendAuditEntry;
  const mockAppendFileSync = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('node:fs');
    vi.mocked(fs.appendFileSync).mockImplementation(mockAppendFileSync);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const mod = await import('../../../src/safety/audit-log.js');
    appendAuditEntry = mod.appendAuditEntry;
    mockAppendFileSync.mockClear();
  });

  it('writes a JSONL entry with required fields', () => {
    appendAuditEntry({
      tool: 'dm.list_hubs',
      kind: 'read',
      stage: 'executed',
      inputRedacted: {},
      outputSummary: { success: true },
    });

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const call = mockAppendFileSync.mock.calls[0]!;
    const rawContent: unknown = call[1];
    const entry = JSON.parse(String(rawContent).trim()) as Record<string, unknown>;

    expect(entry['tool']).toBe('dm.list_hubs');
    expect(entry['kind']).toBe('read');
    expect(entry['stage']).toBe('executed');
    expect(entry['prev_hash']).toBe('sha256:genesis');
    expect(typeof entry['this_hash']).toBe('string');
    expect(String(entry['this_hash'])).toMatch(/^sha256:/);
    expect(typeof entry['id']).toBe('string');
  });

  it('chains hashes across consecutive entries', () => {
    appendAuditEntry({ tool: 'a', kind: 'read', stage: 'executed', inputRedacted: {}, outputSummary: {} });
    appendAuditEntry({ tool: 'b', kind: 'mutation', stage: 'preview', inputRedacted: {}, outputSummary: {} });

    const entry1 = JSON.parse(String(mockAppendFileSync.mock.calls[0]![1]).trim()) as Record<string, unknown>;
    const entry2 = JSON.parse(String(mockAppendFileSync.mock.calls[1]![1]).trim()) as Record<string, unknown>;

    expect(entry2['prev_hash']).toBe(entry1['this_hash']);
  });

  it('redacts secrets from input', () => {
    appendAuditEntry({
      tool: 'test',
      kind: 'mutation',
      stage: 'executed',
      inputRedacted: { access_token: 'super-secret', title: 'My Issue' },
      outputSummary: {},
    });

    const call0 = mockAppendFileSync.mock.calls[0]!;
    const raw: unknown = call0[1];
    const entry = JSON.parse(String(raw).trim()) as Record<string, unknown>;
    const input = entry['input_redacted'] as Record<string, unknown>;
    expect(input['access_token']).toBe('[REDACTED]');
    expect(input['title']).toBe('My Issue');
  });
});
