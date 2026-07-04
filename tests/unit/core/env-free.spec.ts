import { describe, it, expect, vi } from 'vitest';

// Regression guard for the /core subpath invariant: nothing reachable from
// src/core.ts may import config/env.js (it throws at import time when
// APS_CLIENT_ID/SECRET are absent, which would break consumers like n8n
// nodes that supply credentials from their own stores instead of env vars).
// The mock factory throws the moment anything in the import graph pulls env in.
vi.mock('../../../src/config/env.js', () => {
  throw new Error(
    'src/core.ts import graph reached config/env.js — the /core subpath must stay env-free',
  );
});

describe('core subpath is env-free', () => {
  it('imports without APS/SSA/FORMA env vars and without config/env.js', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env)) {
      if (/^(APS_|SSA_|FORMA_)/.test(key)) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }

    try {
      const core = await import('../../../src/core.js');

      expect(core.SsaAuthProvider).toBeTypeOf('function');
      expect(core.TwoLeggedAuthProvider).toBeTypeOf('function');
      expect(core.apsRequest).toBeTypeOf('function');
      expect(core.apsGraphQL).toBeTypeOf('function');
      expect(core.issuesApi.listIssues).toBeTypeOf('function');
      expect(core.aecdmApi.queryElementsByCategory).toBeTypeOf('function');
      expect(core.mcApi.resolveClashes).toBeTypeOf('function');
      expect(core.reviewsApi.listReviews).toBeTypeOf('function');
      expect(core.stripBPrefix('b.1234')).toBe('1234');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it('constructs auth providers from explicit config, no env needed', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env)) {
      if (/^(APS_|SSA_)/.test(key)) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }

    try {
      const { TwoLeggedAuthProvider, SsaAuthProvider } = await import('../../../src/core.js');

      const twoLegged = new TwoLeggedAuthProvider(['data:read'], {
        clientId: 'test-client',
        clientSecret: 'test-secret',
      });
      expect(twoLegged.getScopes()).toEqual(['data:read']);

      // Missing credentials must fail loud with the field names, not undefined behavior
      expect(() => new TwoLeggedAuthProvider(['data:read'])).toThrowError(/APS_CLIENT_ID/);
      expect(() => new SsaAuthProvider(['data:read'], { clientId: 'x' })).toThrowError(
        /clientSecret|SSA_ID/,
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});
