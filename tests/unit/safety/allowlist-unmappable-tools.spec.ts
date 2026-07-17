import { describe, it, expect, vi } from 'vitest';

describe('checkUnmappableToolAllowed', () => {
  it('does not throw when FORMA_ALLOWED_PROJECTS=* (unrestricted)', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: '*' },
    }));
    const { checkUnmappableToolAllowed } = await import('../../../src/safety/allowlist.js');
    expect(() =>
      checkUnmappableToolAllowed('md_trigger_translation', 'Model Derivative URN'),
    ).not.toThrow();
  });

  it('throws AllowlistError with tool name and env var when a single project is allow-listed', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: 'b.abc-123' },
    }));
    const { checkUnmappableToolAllowed, AllowlistError } = await import(
      '../../../src/safety/allowlist.js'
    );
    expect(() => checkUnmappableToolAllowed('md_trigger_translation', 'Model Derivative URN')).toThrow(
      AllowlistError,
    );
    try {
      checkUnmappableToolAllowed('md_trigger_translation', 'Model Derivative URN');
      expect.unreachable('expected checkUnmappableToolAllowed to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AllowlistError);
      expect((err as Error).message).toContain('md_trigger_translation');
      expect((err as Error).message).toContain('FORMA_ALLOWED_PROJECTS');
    }
  });

  it('throws when multiple projects are allow-listed (still cannot map the URN to any of them)', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: 'b.abc,b.def' },
    }));
    const { checkUnmappableToolAllowed, AllowlistError } = await import(
      '../../../src/safety/allowlist.js'
    );
    expect(() =>
      checkUnmappableToolAllowed('md_trigger_translation', 'Model Derivative URN'),
    ).toThrow(AllowlistError);
  });

  it('throws when only FORMA_ALLOWED_HUBS is restricted, even with FORMA_ALLOWED_PROJECTS=* (the bypass this guard closes)', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: 'b.hub-1', FORMA_ALLOWED_PROJECTS: '*' },
    }));
    const { checkUnmappableToolAllowed, AllowlistError } = await import(
      '../../../src/safety/allowlist.js'
    );
    expect(() =>
      checkUnmappableToolAllowed('md_get_manifest', 'Model Derivative URN'),
    ).toThrow(AllowlistError);
  });

  it('does not throw when both FORMA_ALLOWED_HUBS and FORMA_ALLOWED_PROJECTS are *', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: '*' },
    }));
    const { checkUnmappableToolAllowed } = await import('../../../src/safety/allowlist.js');
    expect(() =>
      checkUnmappableToolAllowed('md_get_manifest', 'Model Derivative URN'),
    ).not.toThrow();
  });

  it('error message mentions both FORMA_ALLOWED_HUBS and FORMA_ALLOWED_PROJECTS', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: 'b.hub-1', FORMA_ALLOWED_PROJECTS: '*' },
    }));
    const { checkUnmappableToolAllowed } = await import('../../../src/safety/allowlist.js');
    try {
      checkUnmappableToolAllowed('md_get_manifest', 'Model Derivative URN');
      expect.unreachable('expected checkUnmappableToolAllowed to throw');
    } catch (err) {
      expect((err as Error).message).toContain('FORMA_ALLOWED_HUBS');
      expect((err as Error).message).toContain('FORMA_ALLOWED_PROJECTS');
    }
  });
});
