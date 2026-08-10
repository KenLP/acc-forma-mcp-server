import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { env } from './config/env.js';
import { SsaAuthProvider } from './auth/ssa.js';
import { TwoLeggedAuthProvider } from './auth/two-legged.js';
import type { AuthProvider } from './auth/index.js';
import { SERVER_VERSION } from './version.js';
import { setDefaultApsRegion } from './http/client.js';
import { buildServer } from './server.js';
import { logger } from './logger.js';
import { pruneOldAuditFiles } from './safety/audit-log.js';
import { cleanupExpiredRows } from './persistence/db.js';
import { startHttpServer } from './transport/http.js';
import type { ToolContext } from './tools/_types.js';

/**
 * Sets up the approval-token/rate-counter/idempotency-record persistence backend. Shared by
 * both transports (stdio and http) — identical behavior either way, just invoked at a
 * different point in each branch's startup sequence (see main()).
 */
function setupPersistence(): void {
  if (env.FORMA_PERSISTENCE_MODE === 'sqlite') {
    // better-sqlite3 is a native addon. A packaged single-file executable cannot load it,
    // so fail here with the reason rather than deep inside the first store call with an
    // opaque "Could not locate bindings" error.
    if ((process as { pkg?: unknown }).pkg !== undefined) {
      throw new Error(
        'FORMA_PERSISTENCE_MODE=sqlite is not supported in the packaged executable — ' +
          'better-sqlite3 is a native addon that cannot be bundled into it. ' +
          'Use FORMA_PERSISTENCE_MODE=memory (the default) with the executable, or run the ' +
          'server from a Node.js install (npx / node dist/index.js) if you need durable state.',
      );
    }
    cleanupExpiredRows();
    logger.info(
      { db_path: env.FORMA_DB_PATH },
      'SQLite persistence enabled — approval tokens, rate counters, and idempotency records are durable across restarts',
    );
  } else {
    logger.warn(
      'Approval tokens, rate counters, and idempotency records are stored in-memory only. ' +
        'They will be lost on restart and are not shared across processes. ' +
        'Set FORMA_PERSISTENCE_MODE=sqlite for durable storage.',
    );
  }
}

/**
 * Remote multi-tenant HTTP mode (SPEC_remote-mcp.md, R1). Each caller supplies a bearer key
 * that maps to its own SSA robot credentials via the tenancy store — there is no single
 * process-wide SsaAuthProvider here, unlike stdio mode, because per-process SSA_* env vars
 * may be entirely absent in this mode (config/env.js relaxes that requirement when
 * FORMA_TRANSPORT=http).
 */
async function runHttp(): Promise<void> {
  pruneOldAuditFiles(env);
  setupPersistence();

  // Dynamic import (not a static one) so the stdio path's module graph never pulls in
  // src/tenancy/ — and its better-sqlite3 dependency — at all. src/tenancy/index.ts is
  // owned by a parallel work package; by the time this ran it already existed, so this is
  // a normal typed import, just deferred until the http branch actually executes.
  const { getContextForBearer } = await import('./tenancy/index.js');

  await startHttpServer(env, (bearerKey: string) => getContextForBearer(bearerKey, env));
}

/** Local single-tenant stdio mode — unchanged since before HTTP transport existed. */
async function runStdio(): Promise<void> {
  let auth: AuthProvider;
  let auth2lo: AuthProvider | undefined;

  // Minimum privilege: no account write scope is ever requested (Admin tools only read),
  // and the data write scope is only requested when the server can actually write.
  const writesEnabled = !(env.FORMA_READONLY || env.FORMA_MUTATION_MODE === 'readonly');
  const scopes = ['data:read', 'account:read', ...(writesEnabled ? ['data:write'] : [])];

  // 2-legged provider is always created alongside SSA so DM/Admin tools can use
  // hub-wide project visibility (SSA only sees projects the account is assigned to).
  const twoLegged = new TwoLeggedAuthProvider(scopes);

  switch (env.APS_AUTH_MODE) {
    case 'ssa':
      auth = new SsaAuthProvider(scopes);
      auth2lo = twoLegged; // DM/Admin tools will use this for full hub visibility
      logger.info('Dual auth: SSA (default) + 2LO (DM/Admin tools)');
      break;
    case '2lo':
      auth = twoLegged;
      logger.warn(
        '2-legged auth: Issues/Reviews/AECDM tools are disabled. ' +
          'Use APS_AUTH_MODE=ssa for full functionality.',
      );
      break;
    default:
      throw new Error(`Unsupported APS_AUTH_MODE: ${String(env.APS_AUTH_MODE)}`);
  }

  pruneOldAuditFiles(env);
  setupPersistence();

  const ctx: ToolContext = {
    auth,
    ...(auth2lo !== undefined ? { auth2lo } : {}),
    env,
  };
  const server = buildServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP server connected via stdio — ready to accept tool calls');
}

async function main(): Promise<void> {
  // http/client no longer reads config/env.js (it must stay env-free for the
  // /core subpath) — propagate the validated region here instead.
  setDefaultApsRegion(env.APS_REGION);

  logger.info(
    {
      version: SERVER_VERSION,
      auth_mode: env.APS_AUTH_MODE,
      region: env.APS_REGION,
      mutation_mode: env.FORMA_MUTATION_MODE,
      readonly: env.FORMA_READONLY,
    },
    'acc-forma-mcp-server starting',
  );

  if (env.FORMA_TRANSPORT === 'http') {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error starting acc-forma-mcp-server:', err);
  process.exit(1);
});
