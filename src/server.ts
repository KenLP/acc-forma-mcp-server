import { SERVER_VERSION } from './version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolRegistry } from './tools/_registry.js';
import { setupToolRegistry } from './tools/_setup-registry.js';
import { wrapReadTool, wrapMutationTool, MutationBaseFields } from './tools/_wrap.js';
import type { ToolContext, ReadToolDef, MutationToolDef } from './tools/_types.js';
import { logger } from './logger.js';

export interface BuildServerOptions {
  /**
   * `'setup'` = self-host setup mode (no SSA robot yet, src/selfhost/credentials.ts): only
   * the setup tools are registered. Default `'normal'` registers the product tool set.
   */
  mode?: 'normal' | 'setup';
}

export function buildServer(ctx: ToolContext, options: BuildServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'acc-forma-mcp-server',
    version: SERVER_VERSION,
  });

  let registered = 0;
  let skippedRemote = 0;

  const registry = options.mode === 'setup' ? setupToolRegistry : toolRegistry;

  for (const tool of registry) {
    // remoteEnabled:false tools depend on an auth model (e.g. 2-legged) that the remote
    // multi-tenant transport deliberately does not provide per-tenant — see _types.ts.
    if (ctx.tenantId !== undefined && tool.remoteEnabled === false) {
      skippedRemote++;
      continue;
    }

    const base = tool.inputSchema as z.ZodObject<z.ZodRawShape>;

    if (tool.kind === 'read') {
      const readTool = tool as ReadToolDef<z.ZodTypeAny>;
      server.tool(
        tool.name,
        tool.description,
        base.shape,
        wrapReadTool(readTool, ctx),
      );
    } else {
      const mutTool = tool as MutationToolDef<z.ZodTypeAny>;
      const extendedShape: z.ZodRawShape = {
        ...base.shape,
        ...MutationBaseFields,
      };
      server.tool(
        tool.name,
        tool.description,
        extendedShape,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        wrapMutationTool(mutTool, ctx) as any,
      );
    }

    registered++;
    logger.debug({ tool: tool.name, kind: tool.kind }, 'Tool registered');
  }

  if (skippedRemote > 0) {
    logger.debug({ count: skippedRemote }, 'Tools skipped: remoteEnabled=false under remote transport');
  }
  logger.info({ count: registered, mode: options.mode ?? 'normal' }, 'All tools registered');
  return server;
}
