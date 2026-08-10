import { apsRequest, apsRequestDetailed } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';

/**
 * APS Service Accounts (SSA) management API —
 * https://aps.autodesk.com/en/docs/authentication/v2/reference/http/service-accounts/
 *
 * Lets a publisher application provision/list/disable/delete the robot identities used for
 * Robot-per-Tenant remote mode (see docs/specs/SPEC_remote-mcp.md) instead of doing it by
 * hand in the APS console. Every call needs a 2-legged token carrying one of the four
 * `application:service_account*` scopes below — NOT the tenant robot's own SSA credential
 * (this is the *publisher's* app managing its fleet of robots, not a robot acting for itself).
 *
 * Verified against Autodesk's own OpenAPI spec: host is the default
 * `https://developer.api.autodesk.com` (no region host), and the four scopes are separate —
 * there is no combined `application:service_account:*` wildcard scope.
 */

const SSA_BASE = '/authentication/v2/service-accounts';

/** The four distinct scopes this API requires — read/write are separate per resource. */
export const SSA_ADMIN_SCOPES = [
  'application:service_account:read',
  'application:service_account:write',
  'application:service_account_key:read',
  'application:service_account_key:write',
] as const;

// ---- Types ------------------------------------------------------------------

/**
 * Response status enum has one more value than the two accepted by the PATCH status body
 * (`DEACTIVATED` — set by APS itself, not requestable via `setServiceAccountStatus`).
 */
export type ServiceAccountStatus = 'ENABLED' | 'DISABLED' | 'DEACTIVATED';
export type KeyStatus = 'ENABLED' | 'DISABLED' | 'DEACTIVATED';

export interface CreateServiceAccountInput {
  /** 5-100 chars, alphanumeric + dash, no spaces. See `toServiceAccountName`. */
  name: string;
  /** 5-100 chars, alphanumeric + dash + underscore. */
  firstName: string;
  /** 5-100 chars, alphanumeric + dash. */
  lastName: string;
}

export interface CreatedServiceAccount {
  serviceAccountId: string;
  /** Server-generated robot email: `<name>@<clientId>.adskserviceaccount.autodesk.com`. */
  email: string;
}

export interface ServiceAccountDetails {
  serviceAccountId: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  createdBy?: string;
  status: ServiceAccountStatus;
  createdAt?: string;
  accessedAt?: string;
  expiresAt?: string;
}

export interface ServiceAccountKey {
  kid: string;
  status: KeyStatus;
  createdAt?: string;
  accessedAt?: string;
}

export interface CreatedServiceAccountKey {
  kid: string;
  /** RS256 private key, PEM-encoded. Returned exactly once — APS never shows it again. */
  privateKey: string;
}

// ---- Service accounts ---------------------------------------------------------

/** Create a service account. Max 10 per Client ID (APS-enforced; not checked here). */
export async function createServiceAccount(
  auth: AuthProvider,
  input: CreateServiceAccountInput,
): Promise<CreatedServiceAccount> {
  return apsRequest<CreatedServiceAccount>(auth, SSA_BASE, {
    method: 'POST',
    body: input,
  });
}

/** List every service account under this Client ID. */
export async function listServiceAccounts(auth: AuthProvider): Promise<ServiceAccountDetails[]> {
  const resp = await apsRequest<{ serviceAccounts: ServiceAccountDetails[] }>(auth, SSA_BASE);
  return resp.serviceAccounts ?? [];
}

/** Fetch a single service account's details. */
export async function getServiceAccount(
  auth: AuthProvider,
  serviceAccountId: string,
): Promise<ServiceAccountDetails> {
  return apsRequest<ServiceAccountDetails>(
    auth,
    `${SSA_BASE}/${encodeURIComponent(serviceAccountId)}`,
  );
}

/**
 * Enable or disable a service account. `DEACTIVATED` is a response-only status (APS sets it
 * itself, e.g. on expiry) — not accepted as a request value, hence the narrower param type.
 */
export async function setServiceAccountStatus(
  auth: AuthProvider,
  serviceAccountId: string,
  status: 'ENABLED' | 'DISABLED',
): Promise<ServiceAccountDetails> {
  return apsRequest<ServiceAccountDetails>(
    auth,
    `${SSA_BASE}/${encodeURIComponent(serviceAccountId)}`,
    { method: 'PATCH', body: { status } },
  );
}

/** Delete a service account. APS answers `204` and deletes all of its keys with it. */
export async function deleteServiceAccount(
  auth: AuthProvider,
  serviceAccountId: string,
): Promise<void> {
  await apsRequestDetailed<unknown>(auth, `${SSA_BASE}/${encodeURIComponent(serviceAccountId)}`, {
    method: 'DELETE',
  });
}

// ---- Keys ---------------------------------------------------------------------

/**
 * Create a new key pair for a service account. Max 3 per service account (APS-enforced).
 * `privateKey` is returned exactly once in this response — there is no way to retrieve it
 * again later, only to check the key's status or revoke it.
 */
export async function createServiceAccountKey(
  auth: AuthProvider,
  serviceAccountId: string,
): Promise<CreatedServiceAccountKey> {
  return apsRequest<CreatedServiceAccountKey>(
    auth,
    `${SSA_BASE}/${encodeURIComponent(serviceAccountId)}/keys`,
    { method: 'POST' },
  );
}

/** List a service account's keys (metadata only — never the private key material). */
export async function listServiceAccountKeys(
  auth: AuthProvider,
  serviceAccountId: string,
): Promise<ServiceAccountKey[]> {
  const resp = await apsRequest<{ keys: ServiceAccountKey[] }>(
    auth,
    `${SSA_BASE}/${encodeURIComponent(serviceAccountId)}/keys`,
  );
  return resp.keys ?? [];
}

/** Enable or disable a key. APS answers `204`; there is nothing to parse. */
export async function setServiceAccountKeyStatus(
  auth: AuthProvider,
  serviceAccountId: string,
  keyId: string,
  status: KeyStatus,
): Promise<void> {
  await apsRequestDetailed<unknown>(
    auth,
    `${SSA_BASE}/${encodeURIComponent(serviceAccountId)}/keys/${encodeURIComponent(keyId)}`,
    { method: 'PATCH', body: { status } },
  );
}

/** Delete a key. APS answers `204`; there is nothing to parse. */
export async function deleteServiceAccountKey(
  auth: AuthProvider,
  serviceAccountId: string,
  keyId: string,
): Promise<void> {
  await apsRequestDetailed<unknown>(
    auth,
    `${SSA_BASE}/${encodeURIComponent(serviceAccountId)}/keys/${encodeURIComponent(keyId)}`,
    { method: 'DELETE' },
  );
}

// ---- Pure helpers ---------------------------------------------------------------

/**
 * Slugify free text into a valid `name`/`firstName` value: lowercase, non-alphanumeric runs
 * collapsed to a single dash, leading/trailing dashes trimmed, padded to the 5-char minimum,
 * truncated to the 100-char maximum. Throws if nothing alphanumeric survives (e.g. a string
 * made entirely of punctuation/symbols) — there is no reasonable name to fall back to.
 */
export function toServiceAccountName(freeText: string): string {
  let slug = freeText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length === 0) {
    throw new Error(
      `toServiceAccountName: "${freeText}" has no alphanumeric characters to build a service account name from.`,
    );
  }

  if (slug.length > 100) {
    slug = slug.slice(0, 100).replace(/-+$/g, '');
  }

  while (slug.length < 5) {
    slug = `${slug}-sa`;
  }

  return slug;
}
