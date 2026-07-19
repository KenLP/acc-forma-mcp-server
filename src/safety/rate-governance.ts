import { readFileSync, existsSync } from 'node:fs';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { getRateStore } from '../persistence/rate-store.js';
import { hourBucket } from '../utils/hour-bucket.js';

interface RateConfig {
  [toolName: string]: {
    per_project_per_hour?: number;
  };
}

export const DEFAULT_RATE_CONFIG: RateConfig = {
  'issues_create': { per_project_per_hour: 50 },
  'issues_update': { per_project_per_hour: 100 },
  'issues_add_comment': { per_project_per_hour: 100 },
  'issues_pin_element': { per_project_per_hour: 50 },
  'reviews_create': { per_project_per_hour: 20 },
  'reviews_transition': { per_project_per_hour: 50 },
  // Applies to project-scoped (Issues) hooks only — a folder-scoped hook has no project id
  // to bucket on. webhooks_delete has no entry at all: it is addressed by hook id alone,
  // so there is never a project to count against. APS itself caps creation at 50/minute.
  'webhooks_create': { per_project_per_hour: 20 },
};

function loadConfig(): RateConfig {
  if (env.FORMA_RATE_CONFIG_PATH && existsSync(env.FORMA_RATE_CONFIG_PATH)) {
    return JSON.parse(readFileSync(env.FORMA_RATE_CONFIG_PATH, 'utf-8')) as RateConfig;
  }
  return DEFAULT_RATE_CONFIG;
}

const rateConfig = loadConfig();

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

export function checkRateLimit(toolName: string, projectId: string): void {
  const config = rateConfig[toolName];
  const limit = config?.per_project_per_hour;
  if (limit === undefined) return;

  const bucket = hourBucket();
  const key = `${toolName}::${projectId}::${bucket}`;
  const count = getRateStore().increment(key, bucket);

  if (count > limit) {
    logger.warn({ toolName, projectId, count, limit }, 'Local rate limit exceeded');
    throw new RateGovernanceError(toolName, projectId, limit);
  }
}

// GC stale hour buckets every hour (memory backend)
setInterval(
  () => getRateStore().pruneStale(hourBucket()),
  60 * 60 * 1000,
).unref();
