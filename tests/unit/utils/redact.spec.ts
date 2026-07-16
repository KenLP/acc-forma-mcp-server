import { describe, it, expect, vi } from 'vitest';
import { redact } from '../../../src/utils/redact.js';

// approval.ts pulls in config/env.js (throws without APS creds) — mock it first.
vi.mock('../../../src/config/env.js', () => ({
  env: { FORMA_APPROVAL_TOKEN_TTL: 300, FORMA_PERSISTENCE_MODE: 'memory' },
}));
const { fingerprintToken } = await import('../../../src/safety/approval.js');

describe('redact — approval tokens', () => {
  // Valid ULID suffix (Crockford base32, 26 chars)
  const TOKEN = 'appr_01JZWXYZABCDEFGH23456789AB';

  it('redacts a bare approval token string', () => {
    expect(redact(`token is ${TOKEN} ok`)).toBe('token is appr_[REDACTED] ok');
  });

  it('redacts approval_token / approvalToken object keys', () => {
    const out = redact({ approval_token: TOKEN, approvalToken: TOKEN, other: 'keep' }) as Record<string, unknown>;
    expect(out['approval_token']).toBe('[REDACTED]');
    expect(out['approvalToken']).toBe('[REDACTED]');
    expect(out['other']).toBe('keep');
  });

  it('redacts tokens nested in arrays and objects', () => {
    const out = redact({ list: [`use ${TOKEN}`] }) as { list: string[] };
    expect(out.list[0]).toContain('appr_[REDACTED]');
    expect(out.list[0]).not.toContain(TOKEN);
  });

  it('leaves non-token appr_ strings alone (wrong length/alphabet)', () => {
    expect(redact('appr_short')).toBe('appr_short');
  });
});

describe('fingerprintToken', () => {
  it('is deterministic, 16 hex chars, and does not reveal the token', () => {
    const t = 'appr_01JZWXYZABCDEFGH23456789AB';
    const fp = fingerprintToken(t);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintToken(t)).toBe(fp);
    expect(t).not.toContain(fp);
  });

  it('differs for different tokens', () => {
    expect(fingerprintToken('appr_a')).not.toBe(fingerprintToken('appr_b'));
  });
});
