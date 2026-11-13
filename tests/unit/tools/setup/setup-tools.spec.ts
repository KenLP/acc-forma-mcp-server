import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../../../../src/config/env.js';
import type { McpToolResult, ToolContext } from '../../../../src/tools/_types.js';

const CLIENT_ID = 'AbCdEfGh12345678';
const PEM = '-----BEGIN PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n';

// ssa-admin's network calls are stubbed; the pure helpers (toServiceAccountName,
// SSA_ADMIN_SCOPES) stay real so the robot name is exactly what production would send.
const ssaMocks = {
  listServiceAccounts: vi.fn(),
  createServiceAccount: vi.fn(),
  createServiceAccountKey: vi.fn(),
};

function makeEnv(root: string): Env {
  return {
    APS_CLIENT_ID: CLIENT_ID,
    APS_CLIENT_SECRET: 'test-secret',
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    BIMLYNX_DATA_DIR: join(root, 'data'),
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_ALLOWED_CALLBACK_HOSTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_DIR: join(root, 'data', 'audit'),
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_FAIL_CLOSED: true,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_PERSISTENCE_MODE: 'memory',
    FORMA_RATE_CONFIG_PATH: undefined,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
  } as unknown as Env;
}

/** Every file under `dir`, recursively, as text. */
function readAllFiles(dir: string): Array<{ path: string; text: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? readAllFiles(p) : [{ path: p, text: readFileSync(p, 'utf-8') }];
  });
}

describe('setup tools (self-host setup mode)', () => {
  let root: string;
  let env: Env;
  let ctx: ToolContext;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'bimlynx-setup-'));
    env = makeEnv(root);
    ctx = {
      auth: { getAccessToken: vi.fn().mockResolvedValue('tok'), getScopes: vi.fn().mockReturnValue([]) },
      env,
    };
    vi.doMock('../../../../src/config/env.js', () => ({ env }));
    vi.doMock('../../../../src/apis/ssa-admin.js', async (importActual) => ({
      ...(await importActual<typeof import('../../../../src/apis/ssa-admin.js')>()),
      ...ssaMocks,
    }));
    ssaMocks.listServiceAccounts.mockReset().mockResolvedValue([]);
    ssaMocks.createServiceAccount
      .mockReset()
      .mockResolvedValue({ serviceAccountId: 'SA-NEW', email: 'bimlynx-site-pc@x.adskserviceaccount.autodesk.com' });
    ssaMocks.createServiceAccountKey.mockReset().mockResolvedValue({ kid: 'KID-NEW', privateKey: PEM });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  type RunTool = (input: Record<string, unknown>) => Promise<McpToolResult>;

  async function loadCreate(): Promise<RunTool> {
    const { wrapMutationTool } = await import('../../../../src/tools/_wrap.js');
    const { setupCreateRobotTool } = await import('../../../../src/tools/setup/create-robot.js');
    return (input: Record<string, unknown>) =>
      wrapMutationTool(setupCreateRobotTool, ctx)(input as never);
  }

  async function previewThenExecute(run: RunTool): Promise<McpToolResult> {
    const preview = await run({ robot_name: 'Site PC', dry_run: true });
    expect(preview.isError).toBeFalsy();
    const token = (preview.structuredContent as { approval_token: string }).approval_token;
    return run({ robot_name: 'Site PC', dry_run: false, approval_token: token });
  }

  it('registry: exactly the two setup tools, no-resource, outside the product registry', async () => {
    const { setupToolRegistry } = await import('../../../../src/tools/_setup-registry.js');
    const { toolRegistry } = await import('../../../../src/tools/_registry.js');
    expect(setupToolRegistry.map((t) => [t.name, t.kind, t.scope.kind])).toEqual([
      ['setup_status', 'read', 'no-resource'],
      ['setup_create_robot', 'mutation', 'no-resource'],
    ]);
    const productNames = new Set(toolRegistry.map((t) => t.name));
    expect(setupToolRegistry.some((t) => productNames.has(t.name))).toBe(false);
  });

  it('buildServer in setup mode registers only the setup tools', async () => {
    const { buildServer } = await import('../../../../src/server.js');
    const server = buildServer(ctx, { mode: 'setup' });
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names.sort()).toEqual(['setup_create_robot', 'setup_status']);
  });

  it('dry run previews without creating anything', async () => {
    const run = await loadCreate();
    const preview = await run({ robot_name: 'Site PC', dry_run: true });
    expect(preview.isError).toBeFalsy();
    expect(JSON.stringify(preview.structuredContent)).toContain('bimlynx-site-pc');
    expect(ssaMocks.createServiceAccount).not.toHaveBeenCalled();
    expect(existsSync(join(env.BIMLYNX_DATA_DIR!, 'robot.json'))).toBe(false);
  });

  it('creates the robot, stores the key only in robot-key.pem, and never echoes it', async () => {
    const run = await loadCreate();
    const result = await previewThenExecute(run);

    expect(result.isError).toBeFalsy();
    expect(ssaMocks.createServiceAccount).toHaveBeenCalledWith(ctx.auth, {
      name: 'bimlynx-site-pc',
      firstName: 'bimlynx-site-pc',
      lastName: 'robot',
    });
    expect(result.content[0]?.text).toContain('bimlynx-site-pc@x.adskserviceaccount.autodesk.com');

    const resultText = JSON.stringify(result);
    expect(resultText).not.toContain('SUPERSECRETKEYMATERIAL');

    const dataDir = env.BIMLYNX_DATA_DIR!;
    expect(readFileSync(join(dataDir, 'robot-key.pem'), 'utf-8')).toBe(PEM);
    const record = JSON.parse(readFileSync(join(dataDir, 'robot.json'), 'utf-8')) as Record<string, string>;
    expect(record).toMatchObject({ serviceAccountId: 'SA-NEW', keyId: 'KID-NEW', clientIdPrefix: 'AbCdEfGh' });

    // DoD: the key appears in no file of the data folder except robot-key.pem (audit included).
    const leaks = readAllFiles(dataDir).filter(
      (f) => !f.path.endsWith('robot-key.pem') && f.text.includes('SUPERSECRETKEYMATERIAL'),
    );
    expect(leaks).toEqual([]);
    expect(readAllFiles(join(dataDir, 'audit')).length).toBeGreaterThan(0);
  });

  it('refuses a second robot once one exists', async () => {
    const run = await loadCreate();
    await previewThenExecute(run);
    ssaMocks.createServiceAccount.mockClear();

    const again = await run({ robot_name: 'Other', dry_run: true });
    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toMatch(/already exists/);
    expect(ssaMocks.createServiceAccount).not.toHaveBeenCalled();
  });

  it('two approved setups racing for one folder create only one service account', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    ssaMocks.createServiceAccount.mockImplementation(async () => {
      await gate;
      return { serviceAccountId: 'SA-NEW', email: 'bimlynx-site-pc@x.adskserviceaccount.autodesk.com' };
    });
    const run = await loadCreate();
    const tokenOf = async (): Promise<string> =>
      ((await run({ robot_name: 'Site PC', dry_run: true })).structuredContent as { approval_token: string })
        .approval_token;
    const [t1, t2] = [await tokenOf(), await tokenOf()];

    const first = run({ robot_name: 'Site PC', dry_run: false, approval_token: t1 });
    await vi.waitFor(() => expect(ssaMocks.createServiceAccount).toHaveBeenCalledTimes(1));
    const second = await run({ robot_name: 'Site PC', dry_run: false, approval_token: t2 });
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toMatch(/Another robot setup is running/);

    release();
    expect((await first).isError).toBeFalsy();
    expect(ssaMocks.createServiceAccount).toHaveBeenCalledTimes(1);
    expect(existsSync(join(env.BIMLYNX_DATA_DIR!, 'setup.lock'))).toBe(false);
  });

  it('refuses when the app has no service-account slot left', async () => {
    ssaMocks.listServiceAccounts.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ serviceAccountId: `SA${i}`, email: `${i}@x`, status: 'ENABLED' })),
    );
    const run = await loadCreate();
    const result = await run({ dry_run: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/all 10 service accounts/);
  });

  it('reports the created service account when key creation fails', async () => {
    ssaMocks.createServiceAccountKey.mockRejectedValue(new Error('boom'));
    const run = await loadCreate();
    const result = await previewThenExecute(run);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('SA-NEW');
    expect(existsSync(join(env.BIMLYNX_DATA_DIR!, 'robot.json'))).toBe(false);
  });

  it('setup_status explains a rejected Client ID / secret', async () => {
    const { setupStatusTool } = await import('../../../../src/tools/setup/status.js');
    const badCtx: ToolContext = {
      ...ctx,
      auth: {
        getAccessToken: vi.fn().mockRejectedValue(new Error('2-legged token fetch failed (401): {"error":"invalid_client"}')),
        getScopes: vi.fn().mockReturnValue([]),
      },
    };
    const result = await setupStatusTool.execute({}, badCtx);
    expect(result.content[0]?.text).toMatch(/Client ID \/ Client Secret/);
    expect((result.structuredContent as { readyToCreate: boolean }).readyToCreate).toBe(false);
  });

  it('setup_status is ready to create when credentials work and slots are free', async () => {
    ssaMocks.listServiceAccounts.mockResolvedValue([
      { serviceAccountId: 'SA0', email: 'ops@x', name: 'ops-robot', status: 'ENABLED' },
    ]);
    const { setupStatusTool } = await import('../../../../src/tools/setup/status.js');
    const result = await setupStatusTool.execute({}, ctx);
    expect(result.content[0]?.text).toContain('1 of 10 service accounts used');
    expect((result.structuredContent as { readyToCreate: boolean }).readyToCreate).toBe(true);
  });
});
