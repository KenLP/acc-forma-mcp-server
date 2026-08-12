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

/**
 * Cap on the POST /mcp request body, passed explicitly to express.json() instead of relying
 * on body-parser's own default (100kb, undocumented at the call site otherwise). A JSON-RPC
 * tool-call payload is normally a few KB — tool name, args, JSON-RPC framing; the largest
 * single field across the whole tool surface is issues_create's `description`, capped at
 * 10,000 chars by its own zod schema. 256kb leaves generous headroom above that while still
 * bounding how much body-parser work an unauthenticated caller can trigger with one request.
 * Kept as a named constant so the 413 error message below can state the limit without it
 * drifting out of sync with the express.json() call that enforces it.
 */
const MCP_BODY_LIMIT = '256kb';

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

/**
 * express.json() rejects a body over MCP_BODY_LIMIT by throwing a PayloadTooLargeError (from
 * the `raw-body` package body-parser delegates to) with this `type` and a real
 * `statusCode: 413` on the error object — which the pre-existing catch-all branch in the
 * error middleware below was discarding in favor of a generic 500. Narrowed on `type` (same
 * approach as isBodyParseError) rather than an `instanceof`/error-name check, so this stays
 * correct across raw-body versions without coupling to its exact class hierarchy.
 */
function isBodyTooLargeError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large'
  );
}

function sendMethodNotAllowed(res: Response): void {
  sendJsonRpcError(
    res,
    405,
    -32000,
    'Method not allowed. This is a stateless server — only POST /mcp is supported.',
  );
}

/**
 * `req` carries the resolved ToolContext from `requireBearer` to `handleMcpPost` across the
 * intervening `express.json()` middleware — plain property assignment on the same req object
 * every handler in the chain receives, not a new mechanism.
 */
interface RequestWithContext extends Request {
  toolContext?: ToolContext;
}

/**
 * Auth-before-parse gate for POST /mcp (audit remediation A6, 2026-08-12). Mounted ahead of
 * express.json() in the route chain (see startHttpServer below) so an unauthenticated caller
 * is rejected before the server does any work parsing whatever body it sent — a malformed or
 * oversized body from a caller who never presented a valid bearer key now surfaces as 401,
 * not 400/413. This is a deliberate, documented change in error semantics, not a relaxation:
 * a caller who HAS a valid bearer key still gets the previous 400 (malformed JSON) or 413
 * (over MCP_BODY_LIMIT) behavior — see tests/unit/transport/http.spec.ts.
 *
 * On success, stashes the resolved context on `req` (RequestWithContext) instead of
 * returning it, because Express middleware signatures don't have a return channel back to
 * the route — the next handler in the chain reads it off `req`.
 */
function requireBearer(resolveContext: ContextResolver) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

    (req as RequestWithContext).toolContext = ctx;
    next();
  };
}

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  // requireBearer runs ahead of this handler in the route chain (see startHttpServer) and
  // never calls next() without setting this — a missing context here would mean the route
  // was wired up wrong, not a caller-facing auth failure, hence the 500 rather than 401.
  const ctx = (req as RequestWithContext).toolContext;
  if (!ctx) {
    logger.error('handleMcpPost reached without a resolved ToolContext — route wiring bug');
    if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error');
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
  // No app-level express.json() — body parsing for /mcp is mounted per-route, after auth,
  // below. /healthz and GET / never touch req.body, so they don't need a parser at all.

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Humans (and marketplace reviewers) paste the bare host into a browser; Express's default
  // 404 reads as a broken deployment. MCP clients only ever call /mcp, so this costs nothing.
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send(
        'BIMLynx MCP server.\n\n' +
          'MCP endpoint: POST /mcp (Streamable HTTP, bearer token required)\n' +
          'Health check: GET /healthz\n' +
          'Docs and access requests: https://bimlynx.com\n',
      );
  });

  // Order is load-bearing: requireBearer (auth) -> express.json() (parse) -> handleMcpPost.
  // A caller without a valid bearer key never reaches the parser at all — see requireBearer's
  // doc comment for why that's a deliberate 401-before-400/413 change, not a relaxation.
  app.post(
    '/mcp',
    (req, res, next) => {
      void requireBearer(resolveContext)(req, res, next);
    },
    express.json({ limit: MCP_BODY_LIMIT }),
    (req, res) => {
      void handleMcpPost(req, res);
    },
  );

  // Stateless mode has no session to resume (GET, for the SSE stream) or terminate
  // (DELETE) — both are unsupported, per the SDK's own stateless-mode example.
  app.get('/mcp', (_req, res) => sendMethodNotAllowed(res));
  app.delete('/mcp', (_req, res) => sendMethodNotAllowed(res));

  // Error-handling middleware (4-arg signature — Express dispatches by arity). Must be
  // registered after every route above, including the /mcp route's express.json() call: a
  // malformed or oversized body makes express.json() call next(err), and without this
  // Express's own default handler would answer with an HTML page containing the stack trace
  // and filesystem paths. By the time express.json() ever runs, requireBearer has already
  // accepted the caller's bearer key — see the ordering note on the /mcp route below.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (isBodyParseError(err)) {
      sendJsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
      return;
    }
    if (isBodyTooLargeError(err)) {
      // -32002 is in the JSON-RPC "server error" reserved band (-32000 to -32099), following
      // this file's own precedent (-32000 for 405, -32001 for 401) rather than reusing a
      // spec-defined code that means something else. The limit is stated in the message on
      // purpose — it's actionable for the caller (send a smaller payload) and isn't sensitive,
      // unlike the raw error object, which is intentionally NOT forwarded (no stack, no path).
      sendJsonRpcError(
        res,
        413,
        -32002,
        `Request body exceeds the ${MCP_BODY_LIMIT} limit for POST /mcp`,
      );
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
