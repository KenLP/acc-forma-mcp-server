import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Env } from '../../src/config/env.js';
import type { ToolContext } from '../../src/tools/_types.js';
import type { AuthProvider } from '../../src/auth/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// buildServer() -> _registry.js pulls in every tool file, several of which import
// safety/allowlist.js -> config/env.js, and env.js THROWS at import time when APS creds are
// absent from process.env. Mock env before importing server.js, same pattern as
// tests/unit/manifest-sync.spec.ts and tests/unit/tools/registry-scope.spec.ts.
let buildServer: (ctx: ToolContext) => McpServer;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('../../src/config/env.js', () => ({
    env: {
      FORMA_ALLOWED_HUBS: '*',
      FORMA_ALLOWED_PROJECTS: '*',
      FORMA_RATE_CONFIG_PATH: undefined,
    },
  }));
  ({ buildServer } = await import('../../src/server.js'));
});

// buildServer only registers tool handlers here — it never invokes execute()/buildPreview(),
// so ctx.auth is never called.
const uncalledAuth: AuthProvider = {
  getAccessToken: () => Promise.reject(new Error('unexpected: auth provider was invoked')),
  getScopes: () => [],
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APS_CLIENT_ID: 'test-client-id',
    APS_CLIENT_SECRET: 'test-client-secret',
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_ALLOWED_CALLBACK_HOSTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    ...overrides,
  } as unknown as Env;
}

// The SDK's McpServer stores registered tools on this field (used by its own tools/list and
// tools/call handlers). It's the only introspection point available without spinning up a
// transport, and the same field the SDK itself relies on internally.
function registeredToolNames(server: McpServer): string[] {
  const internal = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools);
}

describe('server.ts — buildServer transport-aware tool registration', () => {
  it('registers all 46 tools when ctx.tenantId is undefined (local/stdio)', () => {
    const ctx: ToolContext = { auth: uncalledAuth, env: makeEnv() };
    const server = buildServer(ctx);
    expect(registeredToolNames(server)).toHaveLength(46);
  });

  it('skips remoteEnabled:false tools (webhooks_list/create/delete) when ctx.tenantId is set (remote transport)', () => {
    const ctx: ToolContext = { auth: uncalledAuth, env: makeEnv(), tenantId: 'tenant-server-spec' };
    const server = buildServer(ctx);
    const names = registeredToolNames(server);
    expect(names).toHaveLength(43);
    expect(names).not.toContain('webhooks_list');
    expect(names).not.toContain('webhooks_create');
    expect(names).not.toContain('webhooks_delete');
  });

  it('an empty tenantId string ("") counts as remote, same as any other tenantId', () => {
    const ctx: ToolContext = { auth: uncalledAuth, env: makeEnv(), tenantId: '' };
    const server = buildServer(ctx);
    expect(registeredToolNames(server)).toHaveLength(43);
  });
});
