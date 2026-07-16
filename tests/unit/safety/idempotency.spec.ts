import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpToolResult } from '../../../src/tools/_types.js';

vi.mock('../../../src/config/env.js', () => ({
  env: { FORMA_APPROVAL_TOKEN_TTL: 300 },
}));

describe('idempotency store', () => {
  let checkIdempotency: typeof import('../../../src/safety/idempotency.js').checkIdempotency;
  let storeIdempotencyResult: typeof import('../../../src/safety/idempotency.js').storeIdempotencyResult;
  let IdempotencyError: typeof import('../../../src/safety/idempotency.js').IdempotencyError;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({ env: { FORMA_APPROVAL_TOKEN_TTL: 300 } }));
    const mod = await import('../../../src/safety/idempotency.js');
    checkIdempotency = mod.checkIdempotency;
    storeIdempotencyResult = mod.storeIdempotencyResult;
    IdempotencyError = mod.IdempotencyError;
  });

  const RESULT: McpToolResult = {
    content: [{ type: 'text', text: 'created' }],
    structuredContent: { id: 'issue-abc' },
  };
  const TOOL = 'issues_create';
  const HASH = 'a'.repeat(64);

  it('returns null for an unknown key', () => {
    expect(checkIdempotency('unknown-key', TOOL, HASH)).toBeNull();
  });

  it('returns cached result on second call with same key + tool + payload', () => {
    storeIdempotencyResult('key-1', TOOL, HASH, RESULT);
    const cached = checkIdempotency('key-1', TOOL, HASH);
    expect(cached).toEqual(RESULT);
  });

  it('rejects the same key reused for a DIFFERENT tool', () => {
    storeIdempotencyResult('key-x', TOOL, HASH, RESULT);
    expect(() => checkIdempotency('key-x', 'reviews_create', HASH)).toThrow(IdempotencyError);
  });

  it('rejects the same key reused with a DIFFERENT payload', () => {
    storeIdempotencyResult('key-y', TOOL, HASH, RESULT);
    expect(() => checkIdempotency('key-y', TOOL, 'b'.repeat(64))).toThrow(IdempotencyError);
  });

  it('returns null after the record expires', () => {
    vi.useFakeTimers();
    storeIdempotencyResult('key-ttl', TOOL, HASH, RESULT);
    // Advance past TTL (300s = 300_000ms)
    vi.advanceTimersByTime(301_000);
    expect(checkIdempotency('key-ttl', TOOL, HASH)).toBeNull();
    vi.useRealTimers();
  });

  it('different keys do not interfere', () => {
    const result2: McpToolResult = { content: [{ type: 'text', text: 'other' }] };
    storeIdempotencyResult('key-a', TOOL, HASH, RESULT);
    storeIdempotencyResult('key-b', TOOL, HASH, result2);
    expect(checkIdempotency('key-a', TOOL, HASH)).toEqual(RESULT);
    expect(checkIdempotency('key-b', TOOL, HASH)).toEqual(result2);
  });
});
