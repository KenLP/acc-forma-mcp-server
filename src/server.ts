import { SERVER_VERSION } from './version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolRegistry } from './tools/_registry.js';
import { wrapReadTool, wrapMutationTool, MutationBaseFields } from './tools/_wrap.js';
import type { ToolContext, ReadToolDef, MutationToolDef } from './tools/_types.js';
import { logger } from './logger.js';

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'acc-forma-mcp-server',
    version: SERVER_VERSION,
  });

  let registered = 0;

  for (const tool of toolRegistry) {
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

  logger.info({ count: registered }, 'All tools registered');
  return server;
}
