import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../../src/config/env.js';

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

const ENV = { FORMA_APPROVAL_TOKEN_TTL: 300 } as unknown as Env;

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
    const token = createApprovalToken('issues.create', { foo: 'bar' }, ENV);
    expect(token).toMatch(/^appr_/);
  });

  it('verifies and consumes a valid token', () => {
    const payload = { toolName: 'issues.create', body: { title: 'Test' } };
    const token = createApprovalToken('issues.create', payload, ENV);
    expect(() => verifyAndConsumeToken(token, 'issues.create', payload, ENV)).not.toThrow();
  });

  it('throws on double-consumption (single-use)', () => {
    const payload = { body: 'same' };
    const token = createApprovalToken('issues.create', payload, ENV);
    verifyAndConsumeToken(token, 'issues.create', payload, ENV);
    expect(() => verifyAndConsumeToken(token, 'issues.create', payload, ENV)).toThrow(ApprovalError);
  });

  it('throws when payload changes between dry-run and execute', () => {
    const original = { title: 'Original' };
    const modified = { title: 'Changed' };
    const token = createApprovalToken('issues.create', original, ENV);
    expect(() => verifyAndConsumeToken(token, 'issues.create', modified, ENV)).toThrow(ApprovalError);
  });

  it('throws when tool name is wrong', () => {
    const payload = { body: 'x' };
    const token = createApprovalToken('issues.create', payload, ENV);
    expect(() => verifyAndConsumeToken(token, 'rfis.create', payload, ENV)).toThrow(ApprovalError);
  });

  it('throws for unknown token', () => {
    expect(() =>
      verifyAndConsumeToken('appr_NOTEXIST', 'issues.create', {}, ENV),
    ).toThrow(ApprovalError);
  });

  it('a token created for tenant A is not found when verified under tenant B (tenant-bound)', () => {
    const payload = { body: 'tenant-scoped' };
    const token = createApprovalToken('issues.create', payload, ENV, 'tenant-a');
    expect(() => verifyAndConsumeToken(token, 'issues.create', payload, ENV, 'tenant-b')).toThrow(ApprovalError);
  });

  it('a token created for tenant A verifies fine under tenant A', () => {
    const payload = { body: 'tenant-scoped' };
    const token = createApprovalToken('issues.create', payload, ENV, 'tenant-a');
    expect(() => verifyAndConsumeToken(token, 'issues.create', payload, ENV, 'tenant-a')).not.toThrow();
  });

  it('a token created with no tenant (local mode) is not found under an explicit tenant', () => {
    const payload = { body: 'local' };
    const token = createApprovalToken('issues.create', payload, ENV);
    expect(() => verifyAndConsumeToken(token, 'issues.create', payload, ENV, 'tenant-a')).toThrow(ApprovalError);
  });
});
