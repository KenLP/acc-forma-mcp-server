import { describe, it, expect, vi, beforeEach } from 'vitest';

// rate-governance.ts deliberately keeps a module-level `import { env }` (see its own
// comment) for FORMA_RATE_CONFIG_PATH — process-level config loaded once at import time,
// same category as the rateConfig it feeds. persistence/rate-store.js also reads
// FORMA_PERSISTENCE_MODE from config/env.js to pick its backend; this mock covers both.
vi.mock('../../../src/config/env.js', () => ({
  env: { FORMA_RATE_CONFIG_PATH: undefined, FORMA_PERSISTENCE_MODE: 'memory' },
}));

describe('rate governance — tenant isolation', () => {
  let checkRateLimit: typeof import('../../../src/safety/rate-governance.js').checkRateLimit;
  let RateGovernanceError: typeof import('../../../src/safety/rate-governance.js').RateGovernanceError;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../../src/safety/rate-governance.js');
    checkRateLimit = mod.checkRateLimit;
    RateGovernanceError = mod.RateGovernanceError;
  });

  // DEFAULT_RATE_CONFIG caps issues_create at 50 calls/project/hour.
  const TOOL = 'issues_create';
  const LIMIT = 50;

  it('counts are isolated per tenant for the same tool + project', () => {
    for (let i = 0; i < LIMIT; i++) {
      expect(() => checkRateLimit(TOOL, 'proj1', 'tenant-a')).not.toThrow();
    }
    expect(() => checkRateLimit(TOOL, 'proj1', 'tenant-a')).toThrow(RateGovernanceError);

    // tenant-b has never called this tool/project — its own counter starts fresh,
    // unaffected by tenant-a having just exhausted its limit.
    expect(() => checkRateLimit(TOOL, 'proj1', 'tenant-b')).not.toThrow();
  });

  it('local mode (tenantId undefined) is isolated from a remote tenant hitting the same tool + project', () => {
    for (let i = 0; i < LIMIT; i++) {
      expect(() => checkRateLimit(TOOL, 'proj2')).not.toThrow(); // undefined tenantId = local mode
    }
    expect(() => checkRateLimit(TOOL, 'proj2')).toThrow(RateGovernanceError);

    // A remote tenant hitting the same tool/project is unaffected by the local counter.
    expect(() => checkRateLimit(TOOL, 'proj2', 'tenant-x')).not.toThrow();
  });

  it('passes the pre-existing bucket-key text unchanged to the store, regardless of tenant', async () => {
    const seen: Array<{ tenantId: string; bucketKey: string }> = [];
    vi.doMock('../../../src/persistence/rate-store.js', () => ({
      getRateStore: () => ({
        increment: (tenantId: string, bucketKey: string) => {
          seen.push({ tenantId, bucketKey });
          return 1;
        },
        pruneStale: () => undefined,
      }),
    }));
    vi.resetModules();

    const mod = await import('../../../src/safety/rate-governance.js');
    mod.checkRateLimit(TOOL, 'proj3'); // local — tenantId undefined
    mod.checkRateLimit(TOOL, 'proj3', 'tenant-z'); // remote

    expect(seen).toHaveLength(2);
    // Local mode is stored under tenant '' — the one dimension that changed.
    expect(seen[0]!.tenantId).toBe('');
    expect(seen[1]!.tenantId).toBe('tenant-z');
    // The bucket key text itself is IDENTICAL for both — the pre-multi-tenant
    // `${toolName}::${projectId}::${bucket}` shape, with no tenant prefix folded in.
    // An existing local SQLite db's bucket_key column values never drift because of this.
    expect(seen[0]!.bucketKey).toBe(seen[1]!.bucketKey);
    expect(seen[0]!.bucketKey).toMatch(/^issues_create::proj3::/);
  });
});
