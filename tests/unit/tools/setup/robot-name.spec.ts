import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The robot's default name comes from the computer's hostname. macOS reports the Bonjour
 * name ("Studio-MacBook-Air.local"), so without stripping the suffix the first real macOS run
 * produced "bimlynx-studio-macbook-air-local" (2026-11-09).
 */
async function defaultNameOn(host: string): Promise<string> {
  vi.doMock('node:os', async (importActual) => ({
    ...(await importActual<typeof import('node:os')>()),
    hostname: () => host,
  }));
  vi.doMock('../../../../src/config/env.js', () => ({
    env: { FORMA_ALLOWED_HUBS: '*', FORMA_ALLOWED_PROJECTS: '*', FORMA_RATE_CONFIG_PATH: undefined },
  }));
  const { robotAccountInput } = await import('../../../../src/tools/setup/create-robot.js');
  return robotAccountInput(undefined).name;
}

describe('setup_create_robot — default robot name', () => {
  beforeEach(() => vi.resetModules());

  it('drops the macOS ".local" suffix', async () => {
    expect(await defaultNameOn('Studio-MacBook-Air.local')).toBe('bimlynx-studio-macbook-air');
  });

  it('matches the suffix case-insensitively', async () => {
    expect(await defaultNameOn('Studio-Mac.LOCAL')).toBe('bimlynx-studio-mac');
  });

  it('leaves other dotted hostnames alone — only a trailing .local is Bonjour noise', async () => {
    expect(await defaultNameOn('build-01.corp.example')).toBe('bimlynx-build-01-corp-example');
  });

  it('a plain Windows hostname is unchanged', async () => {
    expect(await defaultNameOn('SITE-PC-07')).toBe('bimlynx-site-pc-07');
  });
});
