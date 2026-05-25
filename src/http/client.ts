import { logger } from '../logger.js';
import { env } from '../config/env.js';
import type { AuthProvider } from '../auth/index.js';
import { ApsApiError } from './errors.js';

const APS_BASE_URL = 'https://developer.api.autodesk.com';
const GRAPHQL_URL = `${APS_BASE_URL}/aec/graphql`;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;

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
      'x-ads-region': region ?? env.APS_REGION,
    };

    const resp = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });

    // Rate limit — respect Retry-After
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get('Retry-After') ?? backoffMs / 1000);
      const waitMs = retryAfter * 1000;
      logger.warn({ path, attempt, waitMs }, 'Rate limited by APS; backing off');
      if (attempt < MAX_RETRIES) {
        await sleep(waitMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }
    }

    // Transient server errors
    if (resp.status >= 500 && attempt < MAX_RETRIES) {
      logger.warn({ path, status: resp.status, attempt }, 'APS 5xx; retrying');
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }

    if (!resp.ok) {
      const responseBody = await resp.json().catch(async () => await resp.text());
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
    throw new Error(
      `GraphQL error: ${result.errors.map((e) => e.message).join('; ')}`,
    );
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
