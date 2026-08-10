import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Env } from '../../../src/config/env.js';

/**
 * True e2e probe: real HTTP (fetch to an ephemeral port bound by a real Node http.Server),
 * proving multi-tenant isolation end-to-end through transport (src/transport/http.ts) ->
 * tenancy (src/tenancy/) -> the safety pipeline (src/tools/_wrap.ts) -> per-tenant audit +
 * approval-token stores. Companion to tests/unit/transport/http.spec.ts (which uses a fake
 * resolver) — this suite uses the REAL tenancy stack (RobotStore on SQLite, buildTenantContext)
 * so the resolver itself is under test too.
 *
 * No APS credentials are used anywhere in this file, and no call reaches a real Autodesk
 * endpoint: every tool exercised here either never touches ctx.auth (meta_list_changelog,
 * meta_verify_audit_chain — pure local JSONL readers; webhooks_delete's buildPreview, see the
 * "approval token isolation" describe below for why) or is rejected by the safety pipeline
 * BEFORE tool.execute() runs (case 5's cross-tenant token reuse).
 *
 * config/env.js MUST be mocked before any of transport/http.js, tenancy/index.js, or
 * persistence/db.js is imported: those modules (transitively: persistence/db.ts,
 * safety/allowlist.ts, safety/rate-governance.ts, persistence/{token,rate,idempotency}-store.ts)
 * import the `env` singleton directly rather than taking it as a parameter, so swapping it
 * requires vi.doMock + a dynamic import() done AFTER the mock is registered — same pattern as
 * tests/unit/tenancy/robot-store.spec.ts and tests/unit/persistence/cleanup.spec.ts. A static
 * top-level `import` of any of those modules would run against the real ambient .env before
 * beforeAll() ever executes, so everything reachable from the mocked graph is imported
 * dynamically inside beforeAll instead.
 */

const MASTER_KEY = randomBytes(32).toString('hex');
// Never used for signing — no test in this file calls ctx.auth.getAccessToken(), so this
// string never needs to parse as a real RSA PEM (SsaAuthProvider only reads the key file
// lazily inside buildAssertion(), which nothing here triggers).
const FAKE_PEM =
  '-----BEGIN PRIVATE KEY-----\nnot-a-real-key-never-used-for-signing\n-----END PRIVATE KEY-----';

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: number | string | null;
  result: T;
}
interface CallToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let dbDir: string;
let auditRoot: string;
let baseEnv: Env;
let httpServer: Server;
let baseUrl: string;

let _resetDb: () => void;
let createTenant: (typeof import('../../../src/tenancy/index.js'))['createTenant'];
let disableTenant: (typeof import('../../../src/tenancy/index.js'))['disableTenant'];
let getContextForBearer: (typeof import('../../../src/tenancy/index.js'))['getContextForBearer'];

let tenantAId: string;
let tenantBId: string;
let bearerA: string;
let bearerB: string;
let bearerC: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'forma-e2e-db-'));
  auditRoot = mkdtempSync(join(tmpdir(), 'forma-e2e-audit-'));

  baseEnv = {
    APS_CLIENT_ID: 'e2e-client-id',
    APS_CLIENT_SECRET: 'e2e-client-secret',
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_ALLOWED_CALLBACK_HOSTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_FAIL_CLOSED: false,
    FORMA_AUDIT_DIR: auditRoot,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_PERSISTENCE_MODE: 'memory',
    FORMA_DB_PATH: join(dbDir, 'state.db'),
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_TRANSPORT: 'http',
    FORMA_HTTP_PORT: 0, // ephemeral — the real bound port is read off server.address()
    FORMA_MASTER_KEY: MASTER_KEY,
    LOG_LEVEL: 'error',
    LOG_PRETTY: false,
  } as unknown as Env;

  vi.resetModules();
  vi.doMock('../../../src/config/env.js', () => ({ env: baseEnv }));

  const dbModule = await import('../../../src/persistence/db.js');
  dbModule._resetDb();
  _resetDb = dbModule._resetDb;

  const tenancy = await import('../../../src/tenancy/index.js');
  createTenant = tenancy.createTenant;
  disableTenant = tenancy.disableTenant;
  getContextForBearer = tenancy.getContextForBearer;

  const transport = await import('../../../src/transport/http.js');

  const seededA = createTenant(
    { name: 'Tenant A', robotEmail: 'robot-a@example.com', serviceAccountId: 'sa-a', keyId: 'key-a', privateKeyPem: FAKE_PEM },
    baseEnv,
  );
  tenantAId = seededA.tenant.id;
  bearerA = seededA.bearerKey;

  const seededB = createTenant(
    { name: 'Tenant B', robotEmail: 'robot-b@example.com', serviceAccountId: 'sa-b', keyId: 'key-b', privateKeyPem: FAKE_PEM },
    baseEnv,
  );
  tenantBId = seededB.tenant.id;
  bearerB = seededB.bearerKey;

  const seededC = createTenant(
    { name: 'Tenant C (disabled)', robotEmail: 'robot-c@example.com', serviceAccountId: 'sa-c', keyId: 'key-c', privateKeyPem: FAKE_PEM },
    baseEnv,
  );
  bearerC = seededC.bearerKey;
  disableTenant(seededC.tenant.id);

  httpServer = await transport.startHttpServer(baseEnv, (bearerKey) => getContextForBearer(bearerKey, baseEnv));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  _resetDb();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(auditRoot, { recursive: true, force: true });
});

// ---- JSON-RPC helpers --------------------------------------------------------

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

let nextId = 1;

async function rpc(bearerKey: string | undefined, method: string, params?: unknown): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (bearerKey !== undefined) headers.authorization = `Bearer ${bearerKey}`;
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  });
}

/** tools/call, asserting transport-level success (HTTP 200) and returning the tool result. */
async function callTool(
  bearerKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const res = await rpc(bearerKey, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as JsonRpcSuccess<CallToolResult>;
  return body.result;
}

// ---- Case 1: auth ------------------------------------------------------------

describe('transport/http e2e — bearer auth over real HTTP', () => {
  it('missing Authorization header returns 401', async () => {
    const res = await rpc(undefined, 'tools/list');
    expect(res.status).toBe(401);
  });

  it('an unknown bearer key returns 401', async () => {
    const res = await rpc('fmk_totally-wrong-key-does-not-exist', 'tools/list');
    expect(res.status).toBe(401);
  });

  it('a disabled tenant\'s bearer key returns 401', async () => {
    const res = await rpc(bearerC, 'tools/list');
    expect(res.status).toBe(401);
  });
});

// ---- Case 2: tools/list --------------------------------------------------------

describe('transport/http e2e — tools/list', () => {
  it('a valid tenant bearer key lists all 46 registered tools', async () => {
    const initRes = await rpc(bearerA, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e-tenants-spec', version: '0.0.0' },
    });
    expect(initRes.status).toBe(200);

    const listRes = await rpc(bearerA, 'tools/list');
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as JsonRpcSuccess<{ tools: Array<{ name: string }> }>;
    expect(body.result.tools).toHaveLength(46);
  });
});

// ---- Cases 3 & 4: audit isolation + per-tenant hash chain ---------------------

/**
 * meta_list_changelog / meta_verify_audit_chain both read ctx.env.FORMA_AUDIT_DIR, which
 * buildTenantContext (src/tenancy/context.ts) overrides to `<auditRoot>/<tenantId>` per
 * tenant. Both tools are audited themselves (kind: 'read', FORMA_AUDIT_INCLUDE_READS=true by
 * default) — the entry for a call is appended AFTER that call's own execute() returns, so a
 * call never sees its own entry, only entries from calls that already completed.
 */
describe('transport/http e2e — audit isolation across tenants', () => {
  function auditFileFor(tenantId: string): string {
    const today = new Date().toISOString().slice(0, 10);
    return join(auditRoot, tenantId, `audit-${today}.jsonl`);
  }

  function lineCount(filePath: string): number {
    if (!existsSync(filePath)) return 0;
    return readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean).length;
  }

  it('tenant A accumulates its own entries across repeated calls; tenant B stays untouched', async () => {
    expect(lineCount(auditFileFor(tenantAId))).toBe(0);
    expect(lineCount(auditFileFor(tenantBId))).toBe(0);

    const a1 = await callTool(bearerA, 'meta_list_changelog', {});
    expect((a1.structuredContent as { entries: unknown[] }).entries).toHaveLength(0);
    expect(lineCount(auditFileFor(tenantAId))).toBe(1);

    const a2 = await callTool(bearerA, 'meta_list_changelog', {});
    expect((a2.structuredContent as { entries: unknown[] }).entries).toHaveLength(1); // sees a1
    expect(lineCount(auditFileFor(tenantAId))).toBe(2);

    const a3 = await callTool(bearerA, 'meta_list_changelog', {});
    expect((a3.structuredContent as { entries: unknown[] }).entries).toHaveLength(2); // sees a1, a2
    expect(lineCount(auditFileFor(tenantAId))).toBe(3);

    // Tenant B has made zero calls — its directory doesn't even exist — despite A's 3 calls.
    expect(lineCount(auditFileFor(tenantBId))).toBe(0);
  });

  it('tenant B sees none of tenant A\'s prior entries — separate audit directory', async () => {
    const b1 = await callTool(bearerB, 'meta_list_changelog', {});
    // Tenant A has 3 entries on disk at this point (previous test); B must see zero.
    expect((b1.structuredContent as { entries: unknown[] }).entries).toHaveLength(0);
    expect(lineCount(auditFileFor(tenantBId))).toBe(1);
    expect(lineCount(auditFileFor(tenantAId))).toBe(3); // untouched by B's call
  });

  it('audit directories are physically separate files; no entry id crosses tenants', () => {
    const dirA = join(auditRoot, tenantAId);
    const dirB = join(auditRoot, tenantBId);
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
    expect(dirA).not.toBe(dirB);

    const idsA = readFileSync(auditFileFor(tenantAId), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { id: string }).id);
    const idsB = readFileSync(auditFileFor(tenantBId), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { id: string }).id);

    expect(idsA).toHaveLength(3);
    expect(idsB).toHaveLength(1);
    for (const id of idsA) expect(idsB).not.toContain(id);
    for (const id of idsB) expect(idsA).not.toContain(id);
  });

  it('each tenant verifies its own hash chain as valid, with independent entry counts', async () => {
    // Interleave a few more calls across both tenants before verifying — proves the two
    // chains are never merged or cross-checked against each other.
    await callTool(bearerA, 'meta_list_changelog', {});
    await callTool(bearerB, 'meta_list_changelog', {});
    await callTool(bearerA, 'meta_list_changelog', {});

    const expectedCountA = lineCount(auditFileFor(tenantAId));
    const expectedCountB = lineCount(auditFileFor(tenantBId));
    expect(expectedCountA).not.toBe(expectedCountB); // sanity: the two logs really did diverge

    const verifyA = await callTool(bearerA, 'meta_verify_audit_chain', {});
    expect(verifyA.isError).toBeFalsy();
    const bodyA = verifyA.structuredContent as { valid: boolean; entryCount: number };
    expect(bodyA.valid).toBe(true);
    expect(bodyA.entryCount).toBe(expectedCountA);

    const verifyB = await callTool(bearerB, 'meta_verify_audit_chain', {});
    expect(verifyB.isError).toBeFalsy();
    const bodyB = verifyB.structuredContent as { valid: boolean; entryCount: number };
    expect(bodyB.valid).toBe(true);
    expect(bodyB.entryCount).toBe(expectedCountB);
  });

  it('audit actor.ssa_id is each tenant\'s own robot service-account id, not the process-wide one', () => {
    const entriesA = readFileSync(auditFileFor(tenantAId), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { actor: { ssa_id: string | null } }).actor);
    const entriesB = readFileSync(auditFileFor(tenantBId), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { actor: { ssa_id: string | null } }).actor);

    expect(entriesA.length).toBeGreaterThan(0);
    expect(entriesB.length).toBeGreaterThan(0);
    // sa-a / sa-b are the serviceAccountId values passed to createTenant() in beforeAll.
    for (const actor of entriesA) expect(actor.ssa_id).toBe('sa-a');
    for (const actor of entriesB) expect(actor.ssa_id).toBe('sa-b');
    expect(entriesA[0]!.ssa_id).not.toBe(entriesB[0]!.ssa_id);
  });
});

// ---- Case 5: approval token isolation -----------------------------------------

/**
 * webhooks_delete is the one mutation tool whose buildPreview (src/tools/webhooks/delete.ts)
 * is entirely APS-free: it only calls systemForEvent() (src/apis/webhooks.ts, a pure lookup
 * over the DM_EVENTS/ISSUE_EVENTS enums) to build a URL string, and never touches ctx.auth.
 * Every other mutation tool's buildPreview either calls an APS endpoint directly (issues_*,
 * reviews_*, webhooks_create resolve/validate against live data) or — like
 * md_trigger_translation — has no getProjectId to bind rate governance to, which is
 * irrelevant here since this test never reaches rate governance.
 *
 * That property matters for the cross-tenant-token case specifically: tenant B's dry_run=false
 * call with tenant A's token must be rejected at verifyAndConsumeToken() (src/safety/
 * approval.ts), which runs BEFORE tool.execute(). buildPreview always runs first regardless of
 * dry_run (src/tools/_wrap.ts step 5) — an APS-free buildPreview means that step can't fail or
 * hang against fake test credentials, so a wrong result here can only mean the token check
 * itself is broken, not a side effect of missing real APS access.
 */
describe('transport/http e2e — approval token isolation across tenants', () => {
  const payload = { event: 'dm.version.added', hook_id: 'hook-e2e-cross-tenant-test' };

  it('tenant A\'s dry_run approval_token cannot be redeemed by tenant B', async () => {
    const previewA = await callTool(bearerA, 'webhooks_delete', { ...payload, dry_run: true });
    expect(previewA.isError).toBeFalsy();
    const { approval_token: token } = previewA.structuredContent as { approval_token: string };
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const executeAsB = await callTool(bearerB, 'webhooks_delete', {
      ...payload,
      dry_run: false,
      approval_token: token,
    });

    // Rejected as "not found" — proves the token-store lookup is tenant-scoped
    // (MemoryTokenStore keys on `${tenantId}::${id}`, src/persistence/token-store.ts). If
    // isolation were broken this would instead proceed to tool.execute() -> deleteHook(),
    // which would fail differently (a network/auth error against fake APS credentials), not
    // with this specific "Token ... not found" message.
    expect(executeAsB.isError).toBe(true);
    const text = executeAsB.content.map((c) => c.text).join('\n');
    expect(text).toContain('not found');
    expect(text).toContain(token);
  });
});
