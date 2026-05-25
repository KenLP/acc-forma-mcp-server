import type { AuthProvider } from './index.js';
import { TokenCache } from './token-cache.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const TOKEN_ENDPOINT = 'https://developer.api.autodesk.com/authentication/v2/token';

/**
 * Standard 2-legged (client_credentials) auth provider.
 * Only usable for: Account Admin reads, Webhooks, OSS.
 * NOT usable for Issues/RFIs/Reviews/Submittals writes (need 3LO or SSA).
 */
export class TwoLeggedAuthProvider implements AuthProvider {
  private readonly cache = new TokenCache();
  private readonly scopes: string[];

  constructor(scopes: string[]) {
    this.scopes = scopes;
  }

  getScopes(): string[] {
    return this.scopes;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.cache.get();
    if (cached) return cached;
    return this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    const credentials = Buffer.from(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`).toString(
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
