import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildServer } from '../server.js';
import { logger } from '../logger.js';
import type { Env } from '../config/env.js';
import type { ToolContext } from '../tools/_types.js';

/**
 * Resolves a caller-presented bearer key to a fully-formed ToolContext, or null when the
 * key is missing/unknown/disabled. Supplied by the tenancy layer (src/tenancy/) at the
 * index.ts call site — this module never imports tenancy itself, so it stays buildable and
 * unit-testable (with a fake resolver) independent of that store's implementation.
 */
export type ContextResolver = (bearerKey: string) => Promise<ToolContext | null>;

const BEARER_HEADER = /^Bearer\s+(.+)$/i;

function extractBearerKey(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = BEARER_HEADER.exec(header);
  const key = match?.[1]?.trim();
  return key ? key : undefined;
}

/**
 * JSON-RPC-shaped error body, matching the convention the SDK's own stateless-HTTP example
 * uses for its 405 responses (`jsonrpc`/`error`/`id: null`) — callers are MCP JSON-RPC
 * clients, not generic REST clients, so errors outside the transport's own handling (auth
 * failures, method-not-allowed, unexpected exceptions) keep the same envelope shape.
 */
function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * express.json() rejects a malformed body by throwing a SyntaxError with this `type` (set by
 * body-parser) into next(err). Narrowing on `type` rather than `instanceof SyntaxError` alone
 * avoids misclassifying an unrelated SyntaxError thrown later in the request pipeline as a
 * parse error.
 */
function isBodyParseError(err: unknown): boolean {
  return err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed';
}

function sendMethodNotAllowed(res: Response): void {
  sendJsonRpcError(
    res,
    405,
    -32000,
    'Method not allowed. This is a stateless server — only POST /mcp is supported.',
  );
}

async function handleMcpPost(
  req: Request,
  res: Response,
  resolveContext: ContextResolver,
): Promise<void> {
  const bearerKey = extractBearerKey(req.headers.authorization);
  if (!bearerKey) {
    res.set('WWW-Authenticate', 'Bearer');
    sendJsonRpcError(
      res,
      401,
      -32001,
      'Missing or malformed Authorization header — expected "Bearer <key>"',
    );
    return;
  }

  let ctx: ToolContext | null;
  try {
    ctx = await resolveContext(bearerKey);
  } catch (err) {
    logger.error({ err }, 'Context resolver threw while authenticating an HTTP MCP request');
    if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error');
    return;
  }

  if (!ctx) {
    res.set('WWW-Authenticate', 'Bearer');
    sendJsonRpcError(res, 401, -32001, 'Invalid bearer key');
    return;
  }

  try {
    // Stateless mode: a brand-new McpServer + transport per request. Nothing is shared
    // across requests (no sticky session), which is what lets Fly auto-stop the machine
    // when idle and keeps one tenant's server instance from ever touching another's.
    const server = buildServer(ctx);
    // `sessionIdGenerator` is deliberately omitted (not set to `undefined`) — the SDK docs
    // show `sessionIdGenerator: undefined` for stateless mode, but this repo's tsconfig has
    // `exactOptionalPropertyTypes: true`, which rejects an explicit `undefined` for a
    // property typed `sessionIdGenerator?: () => string` (no `| undefined` in the written
    // type). Per the SDK's own doc comment, "If not provided, session management is
    // disabled (stateless mode)" — omitting the key is equivalent and typechecks cleanly.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    res.on('close', () => {
      transport
        .close()
        .catch((err: unknown) => logger.error({ err }, 'Error closing HTTP MCP transport'));
      server
        .close()
        .catch((err: unknown) => logger.error({ err }, 'Error closing per-request MCP server'));
    });

    // Cast to the SDK's own Transport interface: StreamableHTTPServerTransport's onclose/
    // onerror/onmessage accessors are typed `(() => void) | undefined`, which is wider than
    // Transport's `onclose?: () => void` under `exactOptionalPropertyTypes: true` — a
    // mismatch between the SDK's compiled .d.ts and this repo's stricter tsconfig, not an
    // actual behavioral incompatibility (the class declares `implements Transport`).
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.body as unknown);
  } catch (err) {
    logger.error({ err }, 'Unexpected error handling POST /mcp');
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, 'Internal server error');
    }
  }
}

/**
 * Starts the stateless HTTP transport (R1 of docs/specs/SPEC_remote-mcp.md). One express
 * app, one process, listening on env.FORMA_HTTP_PORT / 0.0.0.0 (container-friendly).
 *
 * Deliberately takes `resolveContext` as a parameter rather than importing the tenancy
 * store directly: this keeps src/transport/http.ts free of any dependency on src/tenancy/
 * (and, transitively, better-sqlite3) so it can be unit-tested with a fake resolver and so
 * the stdio path never pulls this module's dependency graph in.
 */
export async function startHttpServer(
  env: Env,
  resolveContext: ContextResolver,
): Promise<Server> {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/mcp', (req, res) => {
    void handleMcpPost(req, res, resolveContext);
  });

  // Stateless mode has no session to resume (GET, for the SSE stream) or terminate
  // (DELETE) — both are unsupported, per the SDK's own stateless-mode example.
  app.get('/mcp', (_req, res) => sendMethodNotAllowed(res));
  app.delete('/mcp', (_req, res) => sendMethodNotAllowed(res));

  // Error-handling middleware (4-arg signature — Express dispatches by arity). Must be
  // registered after every route/app.use above, including express.json(): a malformed body
  // makes express.json() call next(err) BEFORE any route handler runs, and without this
  // Express's own default handler would answer with an HTML page containing the stack trace
  // and filesystem paths — before the request ever reaches the Authorization check.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (isBodyParseError(err)) {
      sendJsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
      return;
    }
    logger.error({ err }, 'Unhandled error in HTTP MCP transport middleware');
    sendJsonRpcError(res, 500, -32603, 'Internal server error');
  });

  return new Promise<Server>((resolve, reject) => {
    const httpServer = app.listen(env.FORMA_HTTP_PORT, '0.0.0.0', () => {
      logger.info(
        { port: env.FORMA_HTTP_PORT },
        'HTTP transport listening (FORMA_TRANSPORT=http)',
      );
      resolve(httpServer);
    });
    httpServer.once('error', reject);
  });
}
