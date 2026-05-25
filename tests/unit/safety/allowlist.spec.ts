import { describe, it, expect, vi } from 'vitest';

describe('allowlist', () => {
  it('allows all when FORMA_ALLOWED_HUBS=*', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: '*' },
    }));
    const { checkHubAllowed, checkProjectAllowed } = await import(
      '../../../src/safety/allowlist.js'
    );
    expect(() => checkHubAllowed('any-hub')).not.toThrow();
    expect(() => checkProjectAllowed('any-project')).not.toThrow();
  });

  it('blocks hub not in allow-list', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: 'hub-allowed', FORMA_ALLOWED_PROJECTS: '*' },
    }));
    const { checkHubAllowed, AllowlistError } = await import(
      '../../../src/safety/allowlist.js'
    );
    expect(() => checkHubAllowed('hub-blocked')).toThrow(AllowlistError);
    expect(() => checkHubAllowed('hub-allowed')).not.toThrow();
  });

  it('matches project with or without b. prefix', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: '*',
        FORMA_ALLOWED_PROJECTS: 'abc-123', // stored without prefix
      },
    }));
    const { checkProjectAllowed } = await import('../../../src/safety/allowlist.js');
    expect(() => checkProjectAllowed('abc-123')).not.toThrow();
    expect(() => checkProjectAllowed('b.abc-123')).not.toThrow(); // b. form also allowed
  });
});
