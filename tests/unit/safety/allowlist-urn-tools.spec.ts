import { describe, it, expect, vi } from 'vitest';

describe('checkUnscopedToolAllowed', () => {
  it('does not throw when FORMA_ALLOWED_PROJECTS=* (unrestricted)', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: '*' },
    }));
    const { checkUnscopedToolAllowed } = await import('../../../src/safety/allowlist.js');
    expect(() =>
      checkUnscopedToolAllowed('md_trigger_translation', 'Model Derivative URN'),
    ).not.toThrow();
  });

  it('throws AllowlistError with tool name and env var when a single project is allow-listed', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({
      env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: 'b.abc-123' },
    }));
    const { checkUnscopedToolAllowed, AllowlistError } = await import(
      '../../../src/safety/allowlist.js'
    );
    expect(() => checkUnscopedToolAllowed('md_trigger_translation', 'Model Derivative URN')).toThrow(
      AllowlistError,
    );
    try {
      checkUnscopedToolAllowed('md_trigger_translation', 'Model Derivative URN');
      expect.unreachable('expected checkUnscopedToolAllowed to throw');
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
    const { checkUnscopedToolAllowed, AllowlistError } = await import(
      '../../../src/safety/allowlist.js'
    );
    expect(() =>
      checkUnscopedToolAllowed('md_trigger_translation', 'Model Derivative URN'),
    ).toThrow(AllowlistError);
  });
});
