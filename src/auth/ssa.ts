import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import type { AuthProvider } from './index.js';
import { TokenCache } from './token-cache.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const TOKEN_ENDPOINT = 'https://developer.api.autodesk.com/authentication/v2/token';
const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const JWT_TTL_SECONDS = 300;

/**
 * Secure Service Account (SSA) auth provider.
 * Implements JWT-bearer grant (RFC 7523) with RS256 signing.
 * Reference: https://aps.autodesk.com/en/docs/oauth/v2/tutorials/create-ssa/
 */
export class SsaAuthProvider implements AuthProvider {
  private readonly cache = new TokenCache();
  private readonly privateKey: string;
  private readonly scopes: string[];

  constructor(scopes: string[]) {
    this.scopes = scopes;
    // Eagerly load key so startup fails fast if path is wrong
    this.privateKey = readFileSync(env.SSA_KEY_PATH!, 'utf-8');
  }

  getScopes(): string[] {
    return this.scopes;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.cache.get();
    if (cached) return cached;
    return this.fetchToken();
  }

  private buildAssertion(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        iss: env.APS_CLIENT_ID,
        sub: env.SSA_ID!,
        aud: TOKEN_ENDPOINT,
        exp: now + JWT_TTL_SECONDS,
        scope: this.scopes,
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        header: { alg: 'RS256', kid: env.SSA_KEY_ID! },
      },
    );
  }

  private async fetchToken(): Promise<string> {
    const assertion = this.buildAssertion();
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
        grant_type: JWT_GRANT_TYPE,
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`SSA token fetch failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as { access_token: string; expires_in: number };
    this.cache.set(data.access_token, data.expires_in);
    logger.debug({ auth_mode: 'ssa', expires_in: data.expires_in }, 'Access token refreshed');
    return data.access_token;
  }
}
