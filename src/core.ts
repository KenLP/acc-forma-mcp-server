/**
 * Public core surface — consumed as `acc-forma-mcp-server/core`.
 *
 * This subpath lets sibling products (n8n nodes, CDE Pulse CLI, gateways)
 * reuse the auth providers and typed APS clients WITHOUT starting the MCP
 * server and WITHOUT the FORMA_* / APS_* env vars that config/env.ts
 * enforces at import time.
 *
 * Invariant: nothing reachable from this file may import config/env.js
 * (it throws when APS_CLIENT_ID/SECRET are absent). Auth providers take
 * explicit config objects and only fall back to process.env per-field.
 * Guarded by tests/unit/core/env-free.spec.ts.
 *
 * API domains are re-exported as namespaces (issuesApi.listIssues(...)) so
 * same-named types in different domains (e.g. Vec3 in aecdm and pushpin)
 * can never collide or be silently dropped by star re-exports.
 */

// ---- Auth -----------------------------------------------------------------
export type { AuthProvider, AuthMode } from './auth/index.js';
export { SsaAuthProvider, type SsaAuthConfig } from './auth/ssa.js';
export { TwoLeggedAuthProvider, type TwoLeggedAuthConfig } from './auth/two-legged.js';
export { TokenCache } from './auth/token-cache.js';

// ---- HTTP layer -----------------------------------------------------------
export {
  apsRequest,
  apsGraphQL,
  setDefaultApsRegion,
  type RequestOptions,
} from './http/client.js';
export { ApsApiError, ApsGraphQLError } from './http/errors.js';

// ---- Utils ----------------------------------------------------------------
export { stripBPrefix, addBPrefix, normalizeProjectId } from './utils/project-id.js';
export { redact } from './utils/redact.js';
export { assertAllowedUrl, DisallowedUrlError, type UrlPolicy } from './utils/url-guard.js';

// ---- Typed APS API clients (namespaced per domain) -------------------------
export * as adminApi from './apis/admin.js';
export * as aecdmApi from './apis/aecdm.js';
export * as dmApi from './apis/data-management.js';
export * as issuesApi from './apis/issues.js';
export * as mcApi from './apis/model-coordination.js';
export * as mdApi from './apis/model-derivative.js';
export * as modelPropertiesApi from './apis/model-properties.js';
export * as pushpinApi from './apis/pushpin.js';
export * as reviewsApi from './apis/reviews.js';
