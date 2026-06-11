import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpToolResult } from '../../../src/tools/_types.js';

vi.mock('../../../src/config/env.js', () => ({
  env: { FORMA_APPROVAL_TOKEN_TTL: 300 },
}));

describe('idempotency store', () => {
  let checkIdempotency: typeof import('../../../src/safety/idempotency.js').checkIdempotency;
  let storeIdempotencyResult: typeof import('../../../src/safety/idempotency.js').storeIdempotencyResult;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({ env: { FORMA_APPROVAL_TOKEN_TTL: 300 } }));
    const mod = await import('../../../src/safety/idempotency.js');
    checkIdempotency = mod.checkIdempotency;
    storeIdempotencyResult = mod.storeIdempotencyResult;
  });

  const RESULT: McpToolResult = {
    content: [{ type: 'text', text: 'created' }],
    structuredContent: { id: 'issue-abc' },
  };

  it('returns null for an unknown key', () => {
    expect(checkIdempotency('unknown-key')).toBeNull();
  });

  it('returns cached result on second call with same key', () => {
    storeIdempotencyResult('key-1', RESULT);
    const cached = checkIdempotency('key-1');
    expect(cached).toEqual(RESULT);
  });

  it('returns null after the record expires', () => {
    vi.useFakeTimers();
    storeIdempotencyResult('key-ttl', RESULT);
    // Advance past TTL (300s = 300_000ms)
    vi.advanceTimersByTime(301_000);
    expect(checkIdempotency('key-ttl')).toBeNull();
    vi.useRealTimers();
  });

  it('different keys do not interfere', () => {
    const result2: McpToolResult = { content: [{ type: 'text', text: 'other' }] };
    storeIdempotencyResult('key-a', RESULT);
    storeIdempotencyResult('key-b', result2);
    expect(checkIdempotency('key-a')).toEqual(RESULT);
    expect(checkIdempotency('key-b')).toEqual(result2);
  });
});
