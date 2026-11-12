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
   * the setup tools are registered.
   *
   * `'self-host'` = the self-host bundle with its robot in place. Every call runs as the
   * robot, so the server reads only what the robot was invited to. Tools that cannot honour
   * that are not registered: account-level reads (`accountLevel`) and tools that only run on
   * a 2-legged token (`requiredAuthModes` without `'ssa'`).
   *
   * Default `'normal'` registers the product tool set.
   */
  mode?: 'normal' | 'setup' | 'self-host';
}

/** Why a tool is left out of the self-host bundle, or undefined when it is kept. */
export function selfHostExclusion(tool: {
  accountLevel?: boolean;
  requiredAuthModes?: readonly string[];
}): 'account-level' | 'needs-2lo' | undefined {
  if (tool.accountLevel === true) return 'account-level';
  if (tool.requiredAuthModes !== undefined && !tool.requiredAuthModes.includes('ssa')) {
    return 'needs-2lo';
  }
  return undefined;
}

export function buildServer(ctx: ToolContext, options: BuildServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'acc-forma-mcp-server',
    version: SERVER_VERSION,
  });

  // The self-host promise — the server reads only the projects the robot was invited to —
  // holds only while no 2-legged token is reachable: a 2LO token sees the whole hub, and
  // tools that prefer one would silently switch to it (see effectiveCtx in _wrap.ts).
  // Refuse to start rather than run with that promise broken.
  if (options.mode === 'self-host' && ctx.auth2lo !== undefined) {
    throw new Error(
      'buildServer: self-host mode must not carry a 2-legged auth provider (ctx.auth2lo) — ' +
        'it would let tools read outside the projects the robot was invited to.',
    );
  }

  let registered = 0;
  let skippedRemote = 0;
  const skippedSelfHost: string[] = [];

  const registry = options.mode === 'setup' ? setupToolRegistry : toolRegistry;

  for (const tool of registry) {
    // remoteEnabled:false tools depend on an auth model (e.g. 2-legged) that the remote
    // multi-tenant transport deliberately does not provide per-tenant — see _types.ts.
    if (ctx.tenantId !== undefined && tool.remoteEnabled === false) {
      skippedRemote++;
      continue;
    }

    if (options.mode === 'self-host' && selfHostExclusion(tool) !== undefined) {
      skippedSelfHost.push(tool.name);
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

  if (skippedSelfHost.length > 0) {
    logger.info({ tools: skippedSelfHost }, 'Tools not registered in self-host mode (account-level or 2-legged only)');
  }
  if (skippedRemote > 0) {
    logger.debug({ count: skippedRemote }, 'Tools skipped: remoteEnabled=false under remote transport');
  }
  logger.info({ count: registered, mode: options.mode ?? 'normal' }, 'All tools registered');
  return server;
}
