import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { env } from './config/env.js';
import type { Env } from './config/env.js';
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
import { resolveSsaCredentials } from './selfhost/credentials.js';
import { SSA_ADMIN_SCOPES } from './apis/ssa-admin.js';
import type { ToolContext } from './tools/_types.js';

/** Re-run interval for pruneOldAuditFiles() after the startup run — see schedulePeriodicAuditPrune(). */
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Runs the audit-retention prune once immediately (startup, unchanged) and then again every
 * 24h for the rest of the process's life. PRIVACY.md promises files older than
 * FORMA_AUDIT_RETENTION_DAYS are "deleted automatically" — a startup-only prune only
 * re-executes when the process restarts, which is not guaranteed: Fly's auto-stop/auto-start
 * topology makes restarts frequent in practice, but a tenant with steady traffic can keep a
 * machine warm (and therefore un-pruned) for months. `.unref()` so this timer never keeps a
 * process alive on its own — stdio must still exit the moment its client disconnects, and an
 * http machine must stay eligible for Fly's auto-stop when idle. pruneOldAuditFiles() already
 * catches and logs its own errors internally (it never throws), so no extra try/catch is
 * needed here — same as the existing setInterval-based cleanups in
 * persistence/token-store.ts (MemoryTokenStore gc) and safety/rate-governance.ts
 * (pruneStale), which follow the identical bare-setInterval(...).unref() shape.
 */
function schedulePeriodicAuditPrune(currentEnv: Env): void {
  pruneOldAuditFiles(currentEnv);
  setInterval(() => pruneOldAuditFiles(currentEnv), AUDIT_PRUNE_INTERVAL_MS).unref();
}

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
    // Same reasoning as schedulePeriodicAuditPrune: a startup-only sweep never re-runs on a
    // machine that stays warm, so expired approval tokens / rate counters / idempotency rows
    // would accumulate in state.db for as long as steady traffic keeps the process alive.
    // Unlike pruneOldAuditFiles, cleanupExpiredRows does not catch its own errors — and an
    // uncaught throw inside a setInterval callback kills the process, so a transient SQLite
    // error (locked db, full disk) must not take the server down with it.
    setInterval(() => {
      try {
        cleanupExpiredRows();
      } catch (err) {
        logger.warn({ err }, 'periodic persistence cleanup failed; will retry next interval');
      }
    }, AUDIT_PRUNE_INTERVAL_MS).unref();
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
  schedulePeriodicAuditPrune(env);
  setupPersistence();

  // Dynamic import (not a static one) so the stdio path's module graph never pulls in
  // src/tenancy/ — and its better-sqlite3 dependency — at all. src/tenancy/index.ts is
  // owned by a parallel work package; by the time this ran it already existed, so this is
  // a normal typed import, just deferred until the http branch actually executes.
  const { getContextForBearer } = await import('./tenancy/index.js');

  await startHttpServer(env, (bearerKey: string) => getContextForBearer(bearerKey, env));
}

/**
 * Self-host setup mode: no SSA robot yet (src/selfhost/credentials.ts). Serves only the
 * setup tools, authenticated with a 2-legged token carrying the service-account management
 * scopes of the user's own app — the one thing those tools need.
 */
async function runSetupMode(dataDir: string, problem: string | undefined): Promise<void> {
  if (problem !== undefined) {
    logger.warn({ data_dir: dataDir, problem }, 'self-host: robot files present but unusable — starting in setup mode');
  } else {
    logger.info({ data_dir: dataDir }, 'self-host: no robot yet — starting in setup mode');
  }

  schedulePeriodicAuditPrune(env);
  setupPersistence();

  const ctx: ToolContext = { auth: new TwoLeggedAuthProvider([...SSA_ADMIN_SCOPES]), env };
  const server = buildServer(ctx, { mode: 'setup' });
  await server.connect(new StdioServerTransport());
  logger.info('MCP server connected via stdio (setup mode) — ready to accept tool calls');
}

/** Local single-tenant stdio mode — unchanged since before HTTP transport existed. */
async function runStdio(): Promise<void> {
  let auth: AuthProvider;
  let auth2lo: AuthProvider | undefined;
  let runEnv: Env = env;

  // BIMLYNX_DATA_DIR is set only by the self-host bundle (bundle-local/manifest.json). That
  // bundle promises the server reads only the projects the robot was invited to, so it runs
  // on the robot's SSA token alone: no 2-legged token for project data is ever created, and
  // the account-level Admin tools are not registered (server.ts mode 'self-host'). This keys
  // off the bundle, not off where the credentials came from — SSA_* vars leaking in from the
  // OS environment must not bring 2LO back.
  const selfHost = env.BIMLYNX_DATA_DIR !== undefined;
  if (selfHost && env.APS_AUTH_MODE !== 'ssa') {
    throw new Error(
      `Self-host (BIMLYNX_DATA_DIR set) runs as the robot only and requires APS_AUTH_MODE=ssa; got ${String(env.APS_AUTH_MODE)}.`,
    );
  }

  // SSA_* env vars (the original path) always win; a robot written by setup_create_robot
  // is only used when they are absent; with neither, the server starts in setup mode.
  const credentials =
    env.APS_AUTH_MODE === 'ssa' ? resolveSsaCredentials(env) : ({ source: 'env' } as const);
  if (credentials.source === 'setup') {
    await runSetupMode(credentials.dataDir, credentials.problem);
    return;
  }

  // Minimum privilege: no account write scope is ever requested (Admin tools only read),
  // and the data write scope is only requested when the server can actually write. The
  // self-host bundle registers no Admin tool, so it does not ask for account:read either.
  const writesEnabled = !(env.FORMA_READONLY || env.FORMA_MUTATION_MODE === 'readonly');
  const scopes = [
    'data:read',
    ...(selfHost ? [] : ['account:read']),
    ...(writesEnabled ? ['data:write'] : []),
  ];

  switch (env.APS_AUTH_MODE) {
    case 'ssa':
      if (credentials.source === 'robot-file') {
        auth = new SsaAuthProvider(scopes, {
          ssaId: credentials.ssaId,
          ssaKeyId: credentials.ssaKeyId,
          ssaKeyPath: credentials.ssaKeyPath,
        });
        // Audit entries attribute to env.SSA_ID — make that the robot actually in use.
        runEnv = { ...env, SSA_ID: credentials.ssaId };
        logger.info({ robot: credentials.email }, 'self-host: using robot from data folder');
      } else {
        auth = new SsaAuthProvider(scopes);
      }
      if (selfHost) {
        logger.info('Self-host: SSA only — every call runs as the robot; no 2-legged token for project data');
      } else {
        // Local dev / orchestrator path: 2LO alongside SSA gives DM/Admin tools hub-wide
        // project visibility (SSA only sees the projects it is assigned to).
        auth2lo = new TwoLeggedAuthProvider(scopes);
        logger.info('Dual auth: SSA (default) + 2LO (DM/Admin tools)');
      }
      break;
    case '2lo':
      auth = new TwoLeggedAuthProvider(scopes);
      logger.warn(
        '2-legged auth: Issues/Reviews/AECDM tools are disabled. ' +
          'Use APS_AUTH_MODE=ssa for full functionality.',
      );
      break;
    default:
      throw new Error(`Unsupported APS_AUTH_MODE: ${String(env.APS_AUTH_MODE)}`);
  }

  schedulePeriodicAuditPrune(runEnv);
  setupPersistence();

  const ctx: ToolContext = {
    auth,
    ...(auth2lo !== undefined ? { auth2lo } : {}),
    env: runEnv,
    ...(credentials.source === 'robot-file' ? { robotEmail: credentials.email } : {}),
  };
  const server = buildServer(ctx, selfHost ? { mode: 'self-host' } : {});

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
