import { logger } from '../logger.js';
import type { AuthProvider } from '../auth/index.js';
import { ApsApiError, ApsGraphQLError } from './errors.js';

const APS_BASE_URL = 'https://developer.api.autodesk.com';
const GRAPHQL_URL = `${APS_BASE_URL}/aec/graphql`;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;

// Region fallback when a request doesn't specify one. Kept as module state
// (not config/env.js) so this file stays importable without FORMA env vars —
// it is part of the `acc-forma-mcp-server/core` public surface. The MCP
// server entrypoint overrides it from env at startup; core consumers either
// call setDefaultApsRegion() once or pass options.region per request.
let defaultApsRegion: string = process.env['APS_REGION'] ?? 'US';

/** Override the region used when RequestOptions.region is not provided. */
export function setDefaultApsRegion(region: string): void {
  defaultApsRegion = region;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  region?: string;
  baseUrl?: string;
}

/** Generic APS REST request with retry/backoff */
export async function apsRequest<T>(
  auth: AuthProvider,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', params, body, region, baseUrl = APS_BASE_URL } = options;
  const url = buildUrl(baseUrl, path, params);
  let backoffMs = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await auth.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ads-region': region ?? defaultApsRegion,
    };

    const resp = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });

    // Expired/invalid token — invalidate cache and retry once with a fresh token
    if (resp.status === 401 && attempt < MAX_RETRIES) {
      logger.warn({ path, attempt }, 'APS 401; invalidating token and retrying');
      auth.invalidateToken?.();
      continue;
    }

    // Rate limit — respect Retry-After header; add jitter to avoid thundering herd
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get('Retry-After') ?? backoffMs / 1000);
      const waitMs = retryAfter * 1000 * (0.5 + Math.random() * 0.5);
      logger.warn({ path, attempt, waitMs }, 'Rate limited by APS; backing off');
      if (attempt < MAX_RETRIES) {
        await sleep(waitMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }
    }

    // Transient server errors — jitter prevents synchronized retry storms
    if (resp.status >= 500 && attempt < MAX_RETRIES) {
      logger.warn({ path, status: resp.status, attempt }, 'APS 5xx; retrying');
      await sleep(backoffMs * (0.5 + Math.random() * 0.5));
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }

    if (!resp.ok) {
      // Read body once as text, then attempt JSON parse — avoids "body already read" if
      // the error response is HTML/plain text (resp.json() would consume the body on failure).
      const text = await resp.text();
      let responseBody: unknown;
      try { responseBody = JSON.parse(text) as unknown; } catch { responseBody = text; }
      throw new ApsApiError(resp.status, method, url, responseBody);
    }

    return (await resp.json()) as T;
  }

  throw new Error(`APS request to ${path} failed after ${MAX_RETRIES} retries`);
}

/** APS GraphQL request (AEC Data Model) */
export async function apsGraphQL<T>(
  auth: AuthProvider,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const result = await apsRequest<{
    data?: T;
    errors?: Array<{ message: string; locations?: unknown }>;
  }>(auth, GRAPHQL_URL, {
    method: 'POST',
    body: { query, variables },
    baseUrl: '',   // path IS the full URL
  });

  if (result.errors && result.errors.length > 0) {
    throw new ApsGraphQLError(GRAPHQL_URL, result.errors);
  }

  return result.data as T;
}

function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  // If base is empty, path is already a full URL
  const url = base ? new URL(path, base) : new URL(path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
