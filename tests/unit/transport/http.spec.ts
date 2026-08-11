import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ContextResolver } from '../../../src/transport/http.js';
import type { Env } from '../../../src/config/env.js';
import type { ToolContext } from '../../../src/tools/_types.js';
import type { AuthProvider } from '../../../src/auth/index.js';

/**
 * config/env.js MUST be mocked before src/transport/http.js is imported: http.ts imports
 * buildServer() from ../server.js, which transitively pulls in every tool file and the
 * safety/* modules — several of those (safety/allowlist.ts among them) import the `env`
 * singleton directly and read from it at module top level (e.g.
 * `parseList(env.FORMA_ALLOWED_HUBS)`), which runs the moment the module is first loaded.
 * A static top-level `import { startHttpServer } from '.../http.js'` would therefore load
 * the real config/env.js (which THROWS when APS_CLIENT_ID/APS_CLIENT_SECRET are absent from
 * process.env) before beforeAll() ever runs — failing this whole file in any environment
 * without a populated .env, including a clean CI checkout. Same pattern as
 * tests/unit/transport/e2e-tenants.spec.ts: vi.doMock (not vi.mock — needs no hoisting, and
 * the fake env is only needed for this file's own dynamic import) + a dynamic import() of
 * startHttpServer done AFTER the mock is registered.
 */

/**
 * Fake Env — only the fields startHttpServer / buildServer's registration path actually
 * touch matter for these tests (FORMA_HTTP_PORT to bind, plus the rest of the shape so this
 * compiles as a real Env). Individual tool execute()s are never invoked here (no dry_run
 * mutation, no real APS call), so most of these values are inert placeholders — same
 * pattern as tests/unit/tenancy/context.spec.ts's makeEnv().
 */
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
    FORMA_AUDIT_FAIL_CLOSED: false,
    FORMA_AUDIT_DIR: '/tmp/forma-transport-spec-audit',
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_PERSISTENCE_MODE: 'memory',
    FORMA_DB_PATH: '/tmp/forma-transport-spec-state.db',
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_TRANSPORT: 'http',
    FORMA_HTTP_PORT: 0, // ephemeral — the real bound port is read off server.address()
    LOG_LEVEL: 'error',
    LOG_PRETTY: false,
    ...overrides,
  } as unknown as Env;
}

// tools/list is served straight from registered tool metadata and never reaches a tool's
// execute()/buildPreview(), so ctx.auth is never called in these tests. Throwing loudly (in
// a real assertion, not just an unused stub) turns a change in that assumption into a
// failing test instead of a silent gap.
const uncalledAuth: AuthProvider = {
  getAccessToken: () => Promise.reject(new Error('unexpected: auth provider was invoked')),
  getScopes: () => [],
};

const VALID_BEARER_KEY = 'valid-test-bearer-key';

const fakeResolver: ContextResolver = (bearerKey) => {
  if (bearerKey !== VALID_BEARER_KEY) return Promise.resolve(null);
  const ctx: ToolContext = { auth: uncalledAuth, env: makeEnv(), tenantId: 'tenant-http-spec' };
  return Promise.resolve(ctx);
};

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: number | string | null;
  result: T;
}
interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string };
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

describe('transport/http — startHttpServer (stateless streamable HTTP)', () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/config/env.js', () => ({ env: makeEnv() }));
    const { startHttpServer } = await import('../../../src/transport/http.js');

    httpServer = await startHttpServer(makeEnv(), fakeResolver);
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /healthz returns 200 with no auth required', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET / points a human at the MCP endpoint instead of a bare 404', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/mcp');
    expect(body).toContain('https://bimlynx.com');
  });

  it('POST /mcp without an Authorization header returns 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = (await res.json()) as JsonRpcFailure;
    expect(body.error.code).toBeTypeOf('number');
  });

  it('POST /mcp with an unknown Bearer key (resolver returns null) returns 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer wrong-key' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as JsonRpcFailure;
    expect(body.error.code).toBeTypeOf('number');
  });

  it('POST /mcp with a valid Bearer key serves initialize then tools/list (46 tools)', async () => {
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${VALID_BEARER_KEY}` };

    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'transport-http-spec', version: '0.0.0' },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as JsonRpcSuccess<{
      serverInfo: { name: string };
    }>;
    expect(initBody.result.serverInfo.name).toBe('acc-forma-mcp-server');

    // Stateless mode: no session ID to carry forward — this is a second, independent
    // request against a brand-new per-request McpServer, same as a real client would send.
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as JsonRpcSuccess<{
      tools: Array<{ name: string }>;
    }>;
    expect(listBody.result.tools).toHaveLength(46);
  });

  it('GET /mcp returns 405 (stateless mode has no SSE resume stream)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as JsonRpcFailure;
    expect(body.error.code).toBeTypeOf('number');
  });

  it('DELETE /mcp returns 405 (stateless mode has no session to terminate)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as JsonRpcFailure;
    expect(body.error.code).toBeTypeOf('number');
  });

  it('POST /mcp with a malformed JSON body returns 400 JSON-RPC error, not a leaked stack trace', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: '{not json!!',
    });
    expect(res.status).toBe(400);

    const rawText = await res.text();
    expect(rawText).not.toContain('node_modules');
    expect(rawText).not.toContain('\\');

    const body = JSON.parse(rawText) as JsonRpcFailure;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBeTypeOf('number');

    // The server must still be healthy after a malformed request — the error-handling
    // middleware must not have crashed the process or left it in a bad state.
    const healthRes = await fetch(`${baseUrl}/healthz`);
    expect(healthRes.status).toBe(200);
  });
});
