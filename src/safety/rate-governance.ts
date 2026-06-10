import { readFileSync, existsSync } from 'node:fs';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

interface RateConfig {
  [toolName: string]: {
    per_project_per_hour?: number;
  };
}

const DEFAULT_RATE_CONFIG: RateConfig = {
  'issues_create': { per_project_per_hour: 50 },
  'issues.update': { per_project_per_hour: 100 },
  'reviews_create': { per_project_per_hour: 20 },
  'reviews_transition': { per_project_per_hour: 50 },
};

function loadConfig(): RateConfig {
  if (env.FORMA_RATE_CONFIG_PATH && existsSync(env.FORMA_RATE_CONFIG_PATH)) {
    return JSON.parse(readFileSync(env.FORMA_RATE_CONFIG_PATH, 'utf-8')) as RateConfig;
  }
  return DEFAULT_RATE_CONFIG;
}

const rateConfig = loadConfig();

// Sliding-window counters keyed by "toolName::projectId::hourBucket".
// LIMITATION: counters reset on process restart and are not shared across
// multiple server processes. Single-process deployment only.
// See docs/REMEDIATION-PLAN.md Fix 6 for the durable-store migration path.
const counters = new Map<string, number>();

export class RateGovernanceError extends Error {
  constructor(toolName: string, projectId: string, limit: number) {
    super(
      `Local rate limit exceeded for "${toolName}" on project ${projectId}: ` +
        `max ${limit} calls/hour. This server-side guard prevents APS quota exhaustion. ` +
        `Wait before retrying, or increase the limit via FORMA_RATE_CONFIG_PATH.`,
    );
    this.name = 'RateGovernanceError';
  }
}

function hourBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

export function checkRateLimit(toolName: string, projectId: string): void {
  const config = rateConfig[toolName];
  const limit = config?.per_project_per_hour;
  if (limit === undefined) return;

  const key = `${toolName}::${projectId}::${hourBucket()}`;
  const count = (counters.get(key) ?? 0) + 1;
  counters.set(key, count);

  if (count > limit) {
    logger.warn({ toolName, projectId, count, limit }, 'Local rate limit exceeded');
    throw new RateGovernanceError(toolName, projectId, limit);
  }
}

// GC: clear stale hour buckets every hour
setInterval(
  () => {
    const current = hourBucket();
    for (const key of counters.keys()) {
      if (!key.endsWith(current)) counters.delete(key);
    }
  },
  60 * 60 * 1000,
).unref();
