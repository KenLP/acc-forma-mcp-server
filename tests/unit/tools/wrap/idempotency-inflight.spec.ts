import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { McpToolResult, MutationToolDef, ToolContext } from '../../../../src/tools/_types.js';
import type { Env } from '../../../../src/config/env.js';

// An idempotency_key is reserved before execute(), not just stored after it. Before this,
// two calls with the same key and their own valid approval tokens could both pass the
// check while the first was still awaiting Autodesk, and both execute.

function makeEnv(): Env {
  return {
    APS_CLIENT_ID: 'test-client',
    APS_CLIENT_SECRET: 'test-secret',
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_FAIL_CLOSED: false,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_PERSISTENCE_MODE: 'memory',
    FORMA_RATE_CONFIG_PATH: undefined,
    FORMA_APPROVAL_TOKEN_TTL: 300,
  } as unknown as Env;
}

const schema = z.object({ project_id: z.string(), title: z.string() });
type Input = z.infer<typeof schema>;
type Handler = (input: Record<string, unknown>) => Promise<McpToolResult>;

const OK: McpToolResult = { content: [{ type: 'text', text: 'ok' }] };
const BASE = { project_id: 'p1', title: 'hello' };
const KEY = 'idem-1';

describe('wrapMutationTool — idempotency_key is reserved while the operation runs', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function load(execute: ReturnType<typeof vi.fn>): Promise<{
    handler: Handler;
    errors: typeof import('../../../../src/http/errors.js');
  }> {
    const env = makeEnv();
    vi.doMock('../../../../src/config/env.js', () => ({ env }));
    vi.doMock('../../../../src/safety/audit-log.js', () => ({
      appendAuditEntry: () => undefined,
      AuditPersistenceError: class extends Error {},
    }));
    const { wrapMutationTool } = await import('../../../../src/tools/_wrap.js');
    const errors = await import('../../../../src/http/errors.js');
    const tool: MutationToolDef<typeof schema> = {
      name: 'test_mutation',
      title: 'Test',
      description: 'Test',
      kind: 'mutation',
      scopes: ['data:write'],
      scope: { kind: 'dm' },
      inputSchema: schema,
      getProjectId: (input: Input) => input.project_id,
      buildPreview: (input: Input) =>
        Promise.resolve({
          method: 'POST',
          url: 'https://developer.api.autodesk.com/x',
          body: {},
          sideEffects: [],
          businessRulesPassed: [],
          executePayload: { title: input.title },
        }),
      execute: execute as unknown as MutationToolDef<typeof schema>['execute'],
    };
    const ctx: ToolContext = {
      auth: { getAccessToken: vi.fn().mockResolvedValue('tok'), getScopes: vi.fn().mockReturnValue([]) },
      env,
    };
    return { handler: wrapMutationTool(tool, ctx) as unknown as Handler, errors };
  }

  async function token(handler: Handler): Promise<string> {
    const preview = await handler({ ...BASE, dry_run: true });
    return (preview.structuredContent as { approval_token: string }).approval_token;
  }

  it('refuses a second call with the same key while the first is still executing', async () => {
    let finish: (r: McpToolResult) => void = () => undefined;
    const exec = vi.fn().mockImplementation(
      () =>
        new Promise<McpToolResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { handler } = await load(exec);
    const [t1, t2] = [await token(handler), await token(handler)];

    const first = handler({ ...BASE, dry_run: false, approval_token: t1, idempotency_key: KEY });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));

    const second = await handler({ ...BASE, dry_run: false, approval_token: t2, idempotency_key: KEY });
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toMatch(/still running or ended without a known outcome/);

    finish(OK);
    expect((await first).isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);

    // Once completed, the same key replays the stored result without executing again.
    const replay = await handler({ ...BASE, dry_run: false, approval_token: await token(handler), idempotency_key: KEY });
    expect(replay).toEqual(OK);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('frees the key when the operation failed before Autodesk applied it', async () => {
    const exec = vi.fn();
    const { handler, errors } = await load(exec);
    exec.mockRejectedValueOnce(new errors.ApsApiError(400, 'POST', '/x', { error: 'bad' }));
    exec.mockResolvedValueOnce(OK);

    const failed = await handler({ ...BASE, dry_run: false, approval_token: await token(handler), idempotency_key: KEY });
    expect(failed.isError).toBe(true);

    const retried = await handler({ ...BASE, dry_run: false, approval_token: await token(handler), idempotency_key: KEY });
    expect(retried.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('frees the key when the approval token is missing (nothing was executed)', async () => {
    const exec = vi.fn().mockResolvedValue(OK);
    const { handler } = await load(exec);

    const missing = await handler({ ...BASE, dry_run: false, idempotency_key: KEY });
    expect(missing.isError).toBe(true);

    const ok = await handler({ ...BASE, dry_run: false, approval_token: await token(handler), idempotency_key: KEY });
    expect(ok.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('keeps the key reserved when the outcome is unknown, so a retry cannot apply it twice', async () => {
    const exec = vi.fn();
    const { handler, errors } = await load(exec);
    exec.mockRejectedValueOnce(new errors.ApsIndeterminateError('POST', '/x', 'socket hang up'));
    exec.mockResolvedValue(OK);

    const unknown = await handler({ ...BASE, dry_run: false, approval_token: await token(handler), idempotency_key: KEY });
    expect(unknown.isError).toBe(true);

    const retry = await handler({ ...BASE, dry_run: false, approval_token: await token(handler), idempotency_key: KEY });
    expect(retry.isError).toBe(true);
    expect(retry.content[0]?.text).toMatch(/meta_list_changelog/);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
