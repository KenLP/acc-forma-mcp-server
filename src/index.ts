import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { env } from './config/env.js';
import { SsaAuthProvider } from './auth/ssa.js';
import { TwoLeggedAuthProvider } from './auth/two-legged.js';
import type { AuthProvider } from './auth/index.js';
import { setDefaultApsRegion } from './http/client.js';
import { buildServer } from './server.js';
import { logger } from './logger.js';
import { pruneOldAuditFiles } from './safety/audit-log.js';
import { cleanupExpiredRows } from './persistence/db.js';

async function main(): Promise<void> {
  // http/client no longer reads config/env.js (it must stay env-free for the
  // /core subpath) — propagate the validated region here instead.
  setDefaultApsRegion(env.APS_REGION);

  logger.info(
    {
      version: '0.1.0',
      auth_mode: env.APS_AUTH_MODE,
      region: env.APS_REGION,
      mutation_mode: env.FORMA_MUTATION_MODE,
      readonly: env.FORMA_READONLY,
    },
    'acc-forma-mcp-server starting',
  );

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

  pruneOldAuditFiles();

  if (env.FORMA_PERSISTENCE_MODE === 'sqlite') {
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

  const ctx: import('./tools/_types.js').ToolContext = {
    auth,
    ...(auth2lo !== undefined ? { auth2lo } : {}),
    env,
  };
  const server = buildServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP server connected via stdio — ready to accept tool calls');
}

main().catch((err: unknown) => {
  console.error('Fatal error starting acc-forma-mcp-server:', err);
  process.exit(1);
});
