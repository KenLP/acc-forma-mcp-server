import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { MutationToolDef, ToolContext } from '../../../../src/tools/_types.js';
import type { Env } from '../../../../src/config/env.js';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

function makeEnv(mutationMode: 'preview_required' | 'client_approval_only' = 'client_approval_only'): Env {
  return {
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    SSA_ID: 'test-ssa',
    APS_CLIENT_ID: 'test-client',
    APS_CLIENT_SECRET: 'test-secret',
    SSA_KEY_ID: 'key-id',
    SSA_KEY_PATH: '/tmp/key.pem',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: mutationMode,
    FORMA_READONLY: false,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_FAIL_CLOSED: true,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_RATE_CONFIG_PATH: undefined,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
  } as unknown as Env;
}

const schema = z.object({ project_id: z.string() });
type Input = z.infer<typeof schema>;

function makeMinimalTool(
  executeMock = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
): MutationToolDef<typeof schema> {
  return {
    name: 'test_tool',
    title: 'Test',
    description: 'Test',
    kind: 'mutation',
    scopes: ['data:write'],
    inputSchema: schema,
    getProjectId: (input: Input) => input.project_id,
    buildPreview: vi.fn().mockResolvedValue({
      method: 'POST',
      url: 'https://example.com',
      body: {},
      sideEffects: [],
      businessRulesPassed: [],
      executePayload: { toolName: 'test_tool' },
    }),
    execute: executeMock,
  };
}

function makeCtx(env: Env): ToolContext {
  return {
    auth: { getAccessToken: vi.fn().mockResolvedValue('tok'), getScopes: vi.fn().mockReturnValue([]) },
    env,
  };
}

describe('wrapMutationTool — AuditPersistenceError messaging (P1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reports NOT executed when audit fails before tool.execute() (dry-run preview audit)', async () => {
    const env = makeEnv('preview_required');
    vi.doMock('../../../../src/config/env.js', () => ({ env }));

    // Make appendAuditEntry throw AuditPersistenceError only on the first call (preview audit)
    vi.doMock('../../../../src/safety/audit-log.js', async () => {
      const real = await vi.importActual<typeof import('../../../../src/safety/audit-log.js')>(
        '../../../../src/safety/audit-log.js',
      );
      let callCount = 0;
      return {
        ...real,
        appendAuditEntry: vi.fn(() => {
          callCount++;
          if (callCount === 1) throw new real.AuditPersistenceError(new Error('disk full'));
        }),
      };
    });

    const { wrapMutationTool } = await import('../../../../src/tools/_wrap.js');
    const tool = makeMinimalTool();
    const wrapped = wrapMutationTool(tool, makeCtx(env));

    const result = await wrapped({ project_id: 'proj-1', dry_run: true });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/NOT executed/i);
    expect(result.content[0]?.text).toMatch(/safe to retry/i);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('reports HAS been applied when audit fails after tool.execute()', async () => {
    const env = makeEnv('client_approval_only');
    vi.doMock('../../../../src/config/env.js', () => ({ env }));

    vi.doMock('../../../../src/safety/audit-log.js', async () => {
      const real = await vi.importActual<typeof import('../../../../src/safety/audit-log.js')>(
        '../../../../src/safety/audit-log.js',
      );
      return {
        ...real,
        appendAuditEntry: vi.fn(() => {
          throw new real.AuditPersistenceError(new Error('disk full'));
        }),
      };
    });

    const { wrapMutationTool } = await import('../../../../src/tools/_wrap.js');
    const executeMock = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'created' }] });
    const tool = makeMinimalTool(executeMock);
    const wrapped = wrapMutationTool(tool, makeCtx(env));

    const result = await wrapped({ project_id: 'proj-1', dry_run: false });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/HAS been applied/i);
    expect(result.content[0]?.text).toMatch(/do NOT retry/i);
    expect(executeMock).toHaveBeenCalled(); // confirms APS call ran
  });
});
