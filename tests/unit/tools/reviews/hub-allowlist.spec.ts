import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { MutationToolDef, ToolContext } from '../../../../src/tools/_types.js';
import type { Env } from '../../../../src/config/env.js';

function makeEnv(allowedHubs: string): Env {
  return {
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    SSA_ID: 'test-ssa',
    APS_CLIENT_ID: 'test-client',
    APS_CLIENT_SECRET: 'test-secret',
    SSA_KEY_ID: 'key-id',
    SSA_KEY_PATH: '/tmp/key.pem',
    FORMA_ALLOWED_HUBS: allowedHubs,
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_RATE_CONFIG_PATH: undefined,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
  } as unknown as Env;
}

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

const schema = z.object({
  hub_id: z.string(),
  project_id: z.string(),
});

type Input = z.infer<typeof schema>;

function makeMinimalTool(): MutationToolDef<typeof schema> {
  return {
    name: 'test_mutation',
    title: 'Test Mutation',
    description: 'Minimal mutation tool for testing hub allow-list.',
    kind: 'mutation',
    scopes: ['data:write'],
    scope: { kind: 'dm' },
    inputSchema: schema,
    getHubId: (input: Input) => input.hub_id,
    getProjectId: (input: Input) => input.project_id,
    buildPreview: vi.fn().mockResolvedValue({
      method: 'POST',
      url: 'https://example.com',
      body: {},
      sideEffects: [],
      businessRulesPassed: [],
      executePayload: { toolName: 'test_mutation' },
    }),
    execute: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    }),
  };
}

function makeCtx(env: Env): ToolContext {
  return {
    auth: { getAccessToken: vi.fn().mockResolvedValue('tok'), getScopes: vi.fn().mockReturnValue([]) },
    env,
  };
}

describe('wrapMutationTool — hub allow-list enforcement', () => {
  let wrapMutationTool: typeof import('../../../../src/tools/_wrap.js').wrapMutationTool;

  beforeEach(() => {
    vi.resetModules();
  });

  it('blocks a hub not in FORMA_ALLOWED_HUBS', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: makeEnv('hub-allowed'),
    }));
    const mod = await import('../../../../src/tools/_wrap.js');
    wrapMutationTool = mod.wrapMutationTool;

    const ctx = makeCtx(makeEnv('hub-allowed'));
    const wrapped = wrapMutationTool(makeMinimalTool(), ctx);

    const result = await wrapped({ hub_id: 'hub-blocked', project_id: 'proj-1', dry_run: true });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/hub-blocked/i);
  });

  it('allows a hub that matches FORMA_ALLOWED_HUBS', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: makeEnv('hub-allowed'),
    }));
    const mod = await import('../../../../src/tools/_wrap.js');
    wrapMutationTool = mod.wrapMutationTool;

    const ctx = makeCtx(makeEnv('hub-allowed'));
    const tool = makeMinimalTool();
    const wrapped = wrapMutationTool(tool, ctx);

    const result = await wrapped({ hub_id: 'hub-allowed', project_id: 'proj-1', dry_run: true });

    // dry_run=true → returns a preview, not an error
    expect(result.isError).toBeUndefined();
    expect(tool.buildPreview).toHaveBeenCalled();
  });

  it('allows any hub when FORMA_ALLOWED_HUBS=*', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: makeEnv('*'),
    }));
    const mod = await import('../../../../src/tools/_wrap.js');
    wrapMutationTool = mod.wrapMutationTool;

    const ctx = makeCtx(makeEnv('*'));
    const tool = makeMinimalTool();
    const wrapped = wrapMutationTool(tool, ctx);

    const result = await wrapped({ hub_id: 'any-hub-id', project_id: 'proj-1', dry_run: true });

    expect(result.isError).toBeUndefined();
    expect(tool.buildPreview).toHaveBeenCalled();
  });
});
