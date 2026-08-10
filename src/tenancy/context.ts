import { join } from 'node:path';
import { SsaAuthProvider } from '../auth/ssa.js';
import { decryptSecret } from './crypto.js';
import type { TenantRecord } from './types.js';
import type { Env } from '../config/env.js';
import type { ToolContext } from '../tools/_types.js';

// Type-only Env import — no config/env.js value import under src/tenancy/. See crypto.ts.

/**
 * Per-tenant SsaAuthProvider cache, keyed by tenant id. The stateless HTTP transport
 * rebuilds ToolContext on every request (R1 §2), but SsaAuthProvider's token cache lives
 * INSIDE the provider instance (see auth/token-cache.ts) — rebuilding the provider itself
 * every request would throw away the cached access token and re-authenticate on every call.
 */
const tenantProviderCache = new Map<string, SsaAuthProvider>();

/**
 * Builds a ToolContext for one tenant: a dedicated SsaAuthProvider (decrypted robot
 * credentials, cached across calls) and env overridden so audit writes land under
 * FORMA_AUDIT_DIR/<tenantId>/ instead of the shared root (see CLAUDE.md's Architecture
 * section on the audit path).
 *
 * No auth2lo is attached here. 2-legged auth sees every project in the WHOLE hub of
 * whichever client credentials it uses — for a per-tenant robot that would defeat the
 * isolation this whole layer exists to provide, so remote-mode tenants only ever get the
 * SSA provider scoped to their own robot membership.
 */
export function buildTenantContext(tenant: TenantRecord, baseEnv: Env): ToolContext {
  if (!baseEnv.FORMA_MASTER_KEY) {
    throw new Error(
      'buildTenantContext: FORMA_MASTER_KEY is required to decrypt tenant robot private keys.',
    );
  }

  let auth = tenantProviderCache.get(tenant.id);
  if (!auth) {
    const privateKey = decryptSecret(tenant.privateKeyCiphertext, baseEnv.FORMA_MASTER_KEY);
    // Mirrors the scope selection in index.ts's stdio bootstrap: minimum privilege, no
    // account write scope, data:write only when the server can actually execute mutations.
    const writesEnabled = !(baseEnv.FORMA_READONLY || baseEnv.FORMA_MUTATION_MODE === 'readonly');
    const scopes = ['data:read', 'account:read', ...(writesEnabled ? ['data:write'] : [])];

    auth = new SsaAuthProvider(scopes, {
      clientId: baseEnv.APS_CLIENT_ID,
      clientSecret: baseEnv.APS_CLIENT_SECRET,
      ssaId: tenant.serviceAccountId,
      ssaKeyId: tenant.keyId,
      privateKey,
    });
    tenantProviderCache.set(tenant.id, auth);
  }

  return {
    auth,
    env: {
      ...baseEnv,
      FORMA_AUDIT_DIR: join(baseEnv.FORMA_AUDIT_DIR, tenant.id),
      // Audit actor identity must be THIS tenant's robot, not the process-wide SSA_ID (which
      // is empty/unset in remote mode) — otherwise every tenant's audit entries attribute
      // mutations to the same (wrong) actor. See CLAUDE.md.
      SSA_ID: tenant.serviceAccountId,
    },
    tenantId: tenant.id,
  };
}

/** Test-only: clears the per-tenant provider cache. Follows the repo's `_reset*` pattern. */
export function _resetTenantContextCache(): void {
  tenantProviderCache.clear();
}
