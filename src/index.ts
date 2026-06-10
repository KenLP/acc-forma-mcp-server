import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { env } from './config/env.js';
import { SsaAuthProvider } from './auth/ssa.js';
import { TwoLeggedAuthProvider } from './auth/two-legged.js';
import type { AuthProvider } from './auth/index.js';
import { buildServer } from './server.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
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

  // 2-legged provider is always created alongside SSA so DM/Admin tools can use
  // hub-wide project visibility (SSA only sees projects the account is assigned to).
  const twoLegged = new TwoLeggedAuthProvider([
    'data:read', 'data:write', 'account:read', 'account:write',
  ]);

  switch (env.APS_AUTH_MODE) {
    case 'ssa':
      auth = new SsaAuthProvider(['data:read', 'data:write', 'account:read', 'account:write']);
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

  const ctx: import('./tools/_types.js').ToolContext = {
    auth,
    ...(auth2lo !== undefined ? { auth2lo } : {}),
    env,
  };
  const server = buildServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP server connected via stdio — ready to accept tool calls');
  logger.warn(
    'Approval tokens and rate counters are stored in-memory only. ' +
      'They will be lost on restart and are not shared across processes. ' +
      'Single-process deployment required until a durable store is implemented.',
  );
}

main().catch((err: unknown) => {
  console.error('Fatal error starting acc-forma-mcp-server:', err);
  process.exit(1);
});
