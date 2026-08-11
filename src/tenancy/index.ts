import type { Env } from '../config/env.js';
import type { ToolContext } from '../tools/_types.js';
import { findTenantByBearerKey } from './robot-store.js';
import { buildTenantContext } from './context.js';

// Type-only Env import — no config/env.js value import under src/tenancy/. See crypto.ts.

/**
 * Entry point the HTTP transport calls per request: Bearer key in, tenant-scoped
 * ToolContext out.
 *
 * Returns null (never throws) for an unknown or disabled tenant — the transport maps a
 * null straight to 401, so a wrong Bearer key never distinguishes "key doesn't exist" from
 * "tenant disabled" in the response (that distinction isn't the caller's to make).
 */
// Async return type is the contract (transport code awaits it); the lookup itself is
// synchronous SQLite today.
// eslint-disable-next-line @typescript-eslint/require-await
export async function getContextForBearer(
  bearerKey: string,
  baseEnv: Env,
): Promise<ToolContext | null> {
  const tenant = findTenantByBearerKey(bearerKey, baseEnv);
  if (!tenant) return null;
  return buildTenantContext(tenant, baseEnv);
}

// Re-exports for the seed CLI and tests.
export {
  createTenant,
  findTenantByBearerKey,
  listTenants,
  disableTenant,
  findTenantsByServiceAccountId,
} from './robot-store.js';
export type { CreateTenantInput } from './robot-store.js';
export { buildTenantContext, _resetTenantContextCache } from './context.js';
export { encryptSecret, decryptSecret } from './crypto.js';
export type { TenantRecord } from './types.js';
