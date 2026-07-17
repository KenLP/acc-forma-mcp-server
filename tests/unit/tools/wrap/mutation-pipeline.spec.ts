import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { MutationToolDef, ToolContext } from '../../../../src/tools/_types.js';
import type { Env } from '../../../../src/config/env.js';

// NOTE on mock strategy: vi.mock(...) factories are hoisted above this file's
// top-level declarations, so a factory that closes over a variable declared
// later in the file only works by accident of *when* the mocked module is
// first imported. This suite instead follows the pattern already used in
// tests/unit/tools/wrap/audit-fail-closed.spec.ts: vi.doMock() (NOT hoisted)
// inside each test, after the captured variables it references already
// exist, plus vi.resetModules() in beforeEach so every test gets a fresh
// _wrap.js (and therefore a fresh in-memory token/idempotency store).

function makeEnv(): Env {
  return {
    APS_CLIENT_ID: 'test-client',
    APS_CLIENT_SECRET: 'test-secret',
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    SSA_ID: 'test-ssa',
    SSA_KEY_ID: 'key-id',
    SSA_KEY_PATH: '/tmp/key.pem',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_FAIL_CLOSED: false,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_PERSISTENCE_MODE: 'memory',
    FORMA_DB_PATH: '/tmp/test-state.db',
    FORMA_RATE_CONFIG_PATH: undefined,
    FORMA_APPROVAL_TOKEN_TTL: 300,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
  } as unknown as Env;
}

const schema = z.object({ project_id: z.string(), title: z.string() });
type Input = z.infer<typeof schema>;

// Tool name deliberately does NOT match any key in DEFAULT_RATE_CONFIG
// (src/safety/rate-governance.ts) so rate governance never engages.
function makeTool(executeMock: ReturnType<typeof vi.fn>): MutationToolDef<typeof schema> {
  return {
    name: 'test_mutation',
    title: 'Test Mutation',
    description: 'Test mutation tool for the wrapMutationTool pipeline',
    kind: 'mutation',
    scopes: ['data:write'],
    inputSchema: schema,
    getProjectId: (input: Input) => input.project_id,
    buildPreview: vi.fn().mockImplementation((input: Input) =>
      Promise.resolve({
        method: 'POST',
        url: 'https://developer.api.autodesk.com/x',
        body: { title: input.title },
        sideEffects: [],
        businessRulesPassed: [],
        executePayload: { title: input.title },
      }),
    ),
    execute: executeMock as unknown as MutationToolDef<typeof schema>['execute'],
  };
}

function makeCtx(env: Env): ToolContext {
  return {
    auth: { getAccessToken: vi.fn().mockResolvedValue('tok'), getScopes: vi.fn().mockReturnValue([]) },
    env,
  };
}

const BASE = { project_id: 'p1', title: 'hello' };

describe('wrapMutationTool — mutation pipeline (Task 8)', () => {
  let auditEntries: unknown[];

  beforeEach(() => {
    vi.resetModules();
    auditEntries = [];
  });

  /**
   * Mocks env + audit-log for this test, then dynamically imports a fresh
   * _wrap.js and returns a wrapped handler bound to a fresh in-memory token
   * store. Must be called after `auditEntries` above has been (re)assigned.
   */
  async function loadWrapped(
    env: Env,
    executeMock: ReturnType<typeof vi.fn>,
  ): Promise<(input: Record<string, unknown>) => Promise<import('../../../../src/tools/_types.js').McpToolResult>> {
    vi.doMock('../../../../src/config/env.js', () => ({ env }));
    vi.doMock('../../../../src/safety/audit-log.js', () => ({
      appendAuditEntry: (entry: unknown) => {
        auditEntries.push(entry);
      },
      AuditPersistenceError: class extends Error {},
    }));

    const { wrapMutationTool } = await import('../../../../src/tools/_wrap.js');
    return wrapMutationTool(makeTool(executeMock), makeCtx(env)) as unknown as (
      input: Record<string, unknown>,
    ) => Promise<import('../../../../src/tools/_types.js').McpToolResult>;
  }

  it('dry_run returns an approval token; the audit log holds only its fingerprint, never the live token', async () => {
    const exec = vi.fn();
    const handler = await loadWrapped(makeEnv(), exec);

    const res = await handler({ ...BASE, dry_run: true });

    const token = (res.structuredContent as Record<string, unknown>)['approval_token'] as string;
    expect(token).toMatch(/^appr_/);
    expect(exec).not.toHaveBeenCalled();

    const auditJson = JSON.stringify(auditEntries);
    expect(auditJson).not.toContain(token); // live token never audited
    expect(auditJson).toContain('approval_token_fp'); // fingerprint is
  });

  it('execute without an approval_token is rejected before tool.execute() runs', async () => {
    const exec = vi.fn();
    const handler = await loadWrapped(makeEnv(), exec);

    const res = await handler({ ...BASE, dry_run: false });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('approval_token is required');
    expect(exec).not.toHaveBeenCalled();
  });

  it('preview -> execute with the issued token succeeds exactly once; the token is single-use', async () => {
    const exec = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const handler = await loadWrapped(makeEnv(), exec);

    const preview = await handler({ ...BASE, dry_run: true });
    const token = (preview.structuredContent as Record<string, unknown>)['approval_token'] as string;

    const res = await handler({ ...BASE, dry_run: false, approval_token: token });
    expect(res.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);

    // Reusing the same (now-consumed) token must fail.
    const again = await handler({ ...BASE, dry_run: false, approval_token: token });
    expect(again.isError).toBe(true);
  });

  it('reusing an idempotency_key for a different payload is rejected', async () => {
    const exec = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const handler = await loadWrapped(makeEnv(), exec);

    const p1 = await handler({ ...BASE, dry_run: true });
    const t1 = (p1.structuredContent as Record<string, unknown>)['approval_token'] as string;
    await handler({ ...BASE, dry_run: false, approval_token: t1, idempotency_key: 'K1' });

    const p2 = await handler({ ...BASE, title: 'DIFFERENT', dry_run: true });
    const t2 = (p2.structuredContent as Record<string, unknown>)['approval_token'] as string;
    const res = await handler({
      ...BASE,
      title: 'DIFFERENT',
      dry_run: false,
      approval_token: t2,
      idempotency_key: 'K1',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('different operation');
  });

  it('a mutation whose request never got a response is audited as outcome_unknown, not failed_api', async () => {
    // A timeout mid-mutation means APS may or may not have applied the change. Recording
    // that as a plain failure would tell the reader the opposite of the truth.
    const { ApsIndeterminateError } = await import('../../../../src/http/errors.js');
    const exec = vi
      .fn()
      .mockRejectedValue(
        new ApsIndeterminateError('POST', 'https://developer.api.autodesk.com/x', 'aborted'),
      );
    const handler = await loadWrapped(makeEnv(), exec);

    const prev = await handler({ ...BASE, dry_run: true });
    const token = (prev.structuredContent as Record<string, unknown>)['approval_token'] as string;
    const res = await handler({ ...BASE, dry_run: false, approval_token: token });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/may or may not have applied/i);

    const executeEntry = (auditEntries as Array<{ stage?: string }>).find(
      (e) => e.stage === 'outcome_unknown',
    );
    expect(executeEntry, 'an outcome_unknown audit entry must exist').toBeDefined();
    expect(
      (auditEntries as Array<{ stage?: string }>).some((e) => e.stage === 'failed_api'),
      'must not also be recorded as a clean failure',
    ).toBe(false);
  });
});
