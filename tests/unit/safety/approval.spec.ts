import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env before importing modules that read it at load time
vi.mock('../../../src/config/env.js', () => ({
  env: {
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    SSA_ID: 'test-ssa-id',
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_RETENTION_DAYS: 90,
  },
}));

describe('approval token', () => {
  let createApprovalToken: typeof import('../../../src/safety/approval.js').createApprovalToken;
  let verifyAndConsumeToken: typeof import('../../../src/safety/approval.js').verifyAndConsumeToken;
  let ApprovalError: typeof import('../../../src/safety/approval.js').ApprovalError;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../../src/safety/approval.js');
    createApprovalToken = mod.createApprovalToken;
    verifyAndConsumeToken = mod.verifyAndConsumeToken;
    ApprovalError = mod.ApprovalError;
  });

  it('issues a token with appr_ prefix', () => {
    const token = createApprovalToken('issues.create', { foo: 'bar' });
    expect(token).toMatch(/^appr_/);
  });

  it('verifies and consumes a valid token', () => {
    const payload = { toolName: 'issues.create', body: { title: 'Test' } };
    const token = createApprovalToken('issues.create', payload);
    expect(() => verifyAndConsumeToken(token, 'issues.create', payload)).not.toThrow();
  });

  it('throws on double-consumption (single-use)', () => {
    const payload = { body: 'same' };
    const token = createApprovalToken('issues.create', payload);
    verifyAndConsumeToken(token, 'issues.create', payload);
    expect(() => verifyAndConsumeToken(token, 'issues.create', payload)).toThrow(ApprovalError);
  });

  it('throws when payload changes between dry-run and execute', () => {
    const original = { title: 'Original' };
    const modified = { title: 'Changed' };
    const token = createApprovalToken('issues.create', original);
    expect(() => verifyAndConsumeToken(token, 'issues.create', modified)).toThrow(ApprovalError);
  });

  it('throws when tool name is wrong', () => {
    const payload = { body: 'x' };
    const token = createApprovalToken('issues.create', payload);
    expect(() => verifyAndConsumeToken(token, 'rfis.create', payload)).toThrow(ApprovalError);
  });

  it('throws for unknown token', () => {
    expect(() =>
      verifyAndConsumeToken('appr_NOTEXIST', 'issues.create', {}),
    ).toThrow(ApprovalError);
  });
});
