import type { AuthProvider } from './index.js';
import { TokenCache } from './token-cache.js';
import { logger } from '../logger.js';

const TOKEN_ENDPOINT = 'https://developer.api.autodesk.com/authentication/v2/token';

/** Explicit credentials; each field falls back to the matching env var. */
export interface TwoLeggedAuthConfig {
  clientId?: string; // APS_CLIENT_ID
  clientSecret?: string; // APS_CLIENT_SECRET
}

/**
 * Standard 2-legged (client_credentials) auth provider.
 * Only usable for: Account Admin reads, Webhooks, OSS.
 * NOT usable for Issues/RFIs/Reviews/Submittals writes (need 3LO or SSA).
 *
 * Must stay importable without config/env.js — it is exported via
 * `acc-forma-mcp-server/core` and env.ts throws when APS vars are absent.
 */
export class TwoLeggedAuthProvider implements AuthProvider {
  private readonly cache = new TokenCache();
  private readonly scopes: string[];
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(scopes: string[], config: TwoLeggedAuthConfig = {}) {
    this.scopes = scopes;

    const clientId = config.clientId ?? process.env['APS_CLIENT_ID'];
    const clientSecret = config.clientSecret ?? process.env['APS_CLIENT_SECRET'];
    const missing: string[] = [];
    if (!clientId) missing.push('clientId (APS_CLIENT_ID)');
    if (!clientSecret) missing.push('clientSecret (APS_CLIENT_SECRET)');
    if (missing.length > 0) {
      throw new Error(`TwoLeggedAuthProvider: missing ${missing.join(', ')}. See docs/AUTH.md.`);
    }
    this.clientId = clientId!;
    this.clientSecret = clientSecret!;
  }

  getScopes(): string[] {
    return this.scopes;
  }

  invalidateToken(): void {
    this.cache.invalidate();
  }

  async getAccessToken(): Promise<string> {
    const cached = this.cache.get();
    if (cached) return cached;
    return this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
      'base64',
    );
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.scopes.join(' '),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`2-legged token fetch failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as { access_token: string; expires_in: number };
    this.cache.set(data.access_token, data.expires_in);
    logger.debug({ auth_mode: '2lo', expires_in: data.expires_in }, 'Access token refreshed');
    return data.access_token;
  }
}
