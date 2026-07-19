import { z } from 'zod';
import { homedir } from 'node:os';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const envSchema = z.object({
  // APS App credentials
  APS_CLIENT_ID: z.string().min(1, 'APS_CLIENT_ID is required'),
  APS_CLIENT_SECRET: z.string().min(1, 'APS_CLIENT_SECRET is required'),

  // Auth mode
  APS_AUTH_MODE: z.enum(['ssa', '2lo', '3lo']).default('ssa'),
  APS_REGION: z.enum(['US', 'EMEA', 'AUS']).default('US'),

  // SSA credentials (required when APS_AUTH_MODE=ssa)
  SSA_ID: z.string().optional(),
  SSA_KEY_ID: z.string().optional(),
  SSA_KEY_PATH: z.string().optional(),

  // Safety: allow-lists
  FORMA_ALLOWED_HUBS: z.string().default('*'),
  FORMA_ALLOWED_PROJECTS: z.string().default('*'),
  /**
   * Hosts a webhook callback URL may point at. A webhook configures ongoing egress of
   * project event data to a third party, so this narrows where that data may be sent.
   * Comma-separated; a leading dot (".example.com") matches subdomains. `*` permits any
   * publicly reachable host (loopback/private addresses are always refused — Autodesk
   * cannot deliver to them).
   */
  FORMA_ALLOWED_CALLBACK_HOSTS: z.string().default('*'),

  // Safety: mutation mode
  FORMA_MUTATION_MODE: z
    .enum(['preview_required', 'client_approval_only', 'readonly'])
    .default('preview_required'),

  // Safety: read-only override
  FORMA_READONLY: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Audit log
  FORMA_AUDIT_FAIL_CLOSED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  FORMA_AUDIT_DIR: z
    .string()
    .default(`${homedir()}/.acc-forma-mcp/audit`)
    // Expand leading `~` to homedir() — Node.js does not do this automatically
    .transform((p) =>
      p.startsWith('~/') || p === '~'
        ? p.replace(/^~/, homedir())
        : p,
    ),
  FORMA_AUDIT_INDEX: z.enum(['none', 'sqlite']).default('none'),
  FORMA_AUDIT_INCLUDE_READS: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  FORMA_AUDIT_RETENTION_DAYS: z
    .string()
    .default('90')
    .transform(Number)
    .refine((n) => Number.isInteger(n) && n > 0, {
      message: 'FORMA_AUDIT_RETENTION_DAYS must be a positive whole number of days',
    }),

  // Persistence backend for approval tokens, rate counters, and idempotency records
  FORMA_PERSISTENCE_MODE: z.enum(['memory', 'sqlite']).default('memory'),
  FORMA_DB_PATH: z
    .string()
    .default(`${homedir()}/.acc-forma-mcp/state.db`)
    .transform((p) =>
      p.startsWith('~/') || p === '~' ? p.replace(/^~/, homedir()) : p,
    ),

  // Rate governance
  FORMA_RATE_CONFIG_PATH: z.string().optional(),

  // Approval token
  FORMA_APPROVAL_TOKEN_TTL: z
    .string()
    .default('300')
    .transform(Number)
    .refine((n) => Number.isInteger(n) && n > 0, {
      message:
        'FORMA_APPROVAL_TOKEN_TTL must be a positive whole number of seconds — a non-numeric value would leave approval tokens that never expire',
    }),

  // Logging
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  LOG_PRETTY: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = result.data;

  if (env.APS_AUTH_MODE === 'ssa') {
    const missing = (['SSA_ID', 'SSA_KEY_ID', 'SSA_KEY_PATH'] as const).filter(
      (k) => !env[k],
    );
    if (missing.length > 0) {
      throw new Error(
        `APS_AUTH_MODE=ssa requires ${missing.join(', ')} to be set. See docs/AUTH.md.`,
      );
    }
  }

  if (env.APS_AUTH_MODE === '3lo') {
    throw new Error(
      '3-legged OAuth (APS_AUTH_MODE=3lo) is planned for Phase 3 and not yet implemented. Use APS_AUTH_MODE=ssa.',
    );
  }

  if (env.FORMA_AUDIT_INDEX === 'sqlite') {
    throw new Error(
      'FORMA_AUDIT_INDEX=sqlite is not yet implemented. Set FORMA_AUDIT_INDEX=none (the default). ' +
        'See docs/adr/0004-audit-log-format.md.',
    );
  }

  return env;
}

export const env = loadEnv();
