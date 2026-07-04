import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import type { AuthProvider } from './index.js';
import { TokenCache } from './token-cache.js';
import { logger } from '../logger.js';

const TOKEN_ENDPOINT = 'https://developer.api.autodesk.com/authentication/v2/token';
const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const JWT_TTL_SECONDS = 300;

/**
 * Explicit credentials for SsaAuthProvider. Every field falls back to the
 * matching env var, so the MCP server keeps constructing with scopes only
 * (config/env.js validates + dotenv-loads process.env before this runs).
 * Core consumers (n8n, CLIs) pass all fields explicitly instead.
 */
export interface SsaAuthConfig {
  clientId?: string; // APS_CLIENT_ID
  clientSecret?: string; // APS_CLIENT_SECRET
  ssaId?: string; // SSA_ID
  ssaKeyId?: string; // SSA_KEY_ID
  /** Absolute path to the RS256 private-key PEM. Ignored when privateKey is set. */
  ssaKeyPath?: string; // SSA_KEY_PATH
  /** PEM content directly (credential stores that hold the key, not a path). */
  privateKey?: string;
}

/**
 * Secure Service Account (SSA) auth provider.
 * Implements JWT-bearer grant (RFC 7523) with RS256 signing.
 * Reference: https://aps.autodesk.com/en/docs/oauth/v2/tutorials/create-ssa/
 *
 * Must stay importable without config/env.js — it is exported via
 * `acc-forma-mcp-server/core` and env.ts throws when APS vars are absent.
 */
export class SsaAuthProvider implements AuthProvider {
  private readonly cache = new TokenCache();
  private readonly privateKey: string;
  private readonly scopes: string[];
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly ssaId: string;
  private readonly ssaKeyId: string;

  constructor(scopes: string[], config: SsaAuthConfig = {}) {
    this.scopes = scopes;

    const clientId = config.clientId ?? process.env['APS_CLIENT_ID'];
    const clientSecret = config.clientSecret ?? process.env['APS_CLIENT_SECRET'];
    const ssaId = config.ssaId ?? process.env['SSA_ID'];
    const ssaKeyId = config.ssaKeyId ?? process.env['SSA_KEY_ID'];
    const ssaKeyPath = config.ssaKeyPath ?? process.env['SSA_KEY_PATH'];

    const missing: string[] = [];
    if (!clientId) missing.push('clientId (APS_CLIENT_ID)');
    if (!clientSecret) missing.push('clientSecret (APS_CLIENT_SECRET)');
    if (!ssaId) missing.push('ssaId (SSA_ID)');
    if (!ssaKeyId) missing.push('ssaKeyId (SSA_KEY_ID)');
    if (!config.privateKey && !ssaKeyPath) missing.push('privateKey or ssaKeyPath (SSA_KEY_PATH)');
    if (missing.length > 0) {
      throw new Error(`SsaAuthProvider: missing ${missing.join(', ')}. See docs/AUTH.md.`);
    }

    this.clientId = clientId!;
    this.clientSecret = clientSecret!;
    this.ssaId = ssaId!;
    this.ssaKeyId = ssaKeyId!;
    // Eagerly load key so startup fails fast if path is wrong
    this.privateKey = config.privateKey ?? readFileSync(ssaKeyPath!, 'utf-8');
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

  private buildAssertion(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        iss: this.clientId,
        sub: this.ssaId,
        aud: TOKEN_ENDPOINT,
        exp: now + JWT_TTL_SECONDS,
        scope: this.scopes,
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        header: { alg: 'RS256', kid: this.ssaKeyId },
      },
    );
  }

  private async fetchToken(): Promise<string> {
    const assertion = this.buildAssertion();
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
