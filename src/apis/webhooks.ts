import { createHmac, timingSafeEqual } from 'node:crypto';
import { apsRequest, apsRequestDetailed } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';

/**
 * APS Webhooks API v1 — https://aps.autodesk.com/en/docs/webhooks/v1/
 *
 * Three behaviors of this API differ from every other APS endpoint this server calls, and
 * each one breaks a naive client:
 *  - create answers `201` with an EMPTY body; the new hook id is only in `Location`
 *  - list answers `204` (no body at all) when there are no hooks
 *  - hooks are region-partitioned: one created under x-ads-region=EMEA is invisible to a
 *    list call made under US. Mismatched region reads as "the hook vanished".
 */

const WEBHOOKS_BASE = '/webhooks/v1';

// ---- Systems & events -------------------------------------------------------

/**
 * The APS "system" a hook belongs to. Only the two this server supports are listed;
 * the full enum also covers derivative, adsk.c4r, cost, bc, tandem.
 */
export const WEBHOOK_SYSTEMS = {
  /** Data Management — files, folders, versions. Hooks are scoped to a FOLDER urn. */
  data: 'data',
  /** ACC/Forma Issues. Hooks are scoped to a PROJECT id. */
  issues: 'autodesk.construction.issues',
} as const;

export type WebhookSystem = (typeof WEBHOOK_SYSTEMS)[keyof typeof WEBHOOK_SYSTEMS];

/** Data Management events. `dm.version.added` is the "a new file version was uploaded" hook. */
export const DM_EVENTS = [
  'dm.version.added',
  'dm.version.modified',
  'dm.version.deleted',
  'dm.version.moved',
  'dm.version.copied',
  'dm.lineage.reserved',
  'dm.lineage.unreserved',
  'dm.lineage.updated',
  'dm.folder.added',
  'dm.folder.modified',
  'dm.folder.deleted',
  'dm.folder.purged',
  'dm.folder.moved',
  'dm.folder.copied',
  'dm.operation.started',
  'dm.operation.completed',
] as const;

/**
 * ACC Issues events. The `-1.0` suffix is part of the event name — `issue.created` alone
 * is not a valid event and the API rejects it.
 */
export const ISSUE_EVENTS = [
  'issue.created-1.0',
  'issue.updated-1.0',
  'issue.deleted-1.0',
  'issue.restored-1.0',
  'issue.unlinked-1.0',
] as const;

export type DmEvent = (typeof DM_EVENTS)[number];
export type IssueEvent = (typeof ISSUE_EVENTS)[number];
export type WebhookEvent = DmEvent | IssueEvent;

/** Which system owns an event, and which scope key its hook must carry. */
export function systemForEvent(event: string): {
  system: WebhookSystem;
  scopeKey: 'folder' | 'project';
} {
  if ((ISSUE_EVENTS as readonly string[]).includes(event)) {
    return { system: WEBHOOK_SYSTEMS.issues, scopeKey: 'project' };
  }
  if ((DM_EVENTS as readonly string[]).includes(event)) {
    return { system: WEBHOOK_SYSTEMS.data, scopeKey: 'folder' };
  }
  throw new Error(
    `Unknown webhook event "${event}". Supported: ${[...DM_EVENTS, ...ISSUE_EVENTS].join(', ')}`,
  );
}

// ---- Types ------------------------------------------------------------------

export interface WebhookHook {
  hookId: string;
  tenant?: string;
  callbackUrl: string;
  createdBy?: string;
  event: string;
  createdDate?: string;
  system: string;
  creatorType?: string;
  status?: 'active' | 'inactive' | 'reactivated';
  scope?: Record<string, string>;
  hookAttribute?: Record<string, unknown>;
  autoReactivateHook?: boolean;
  hookExpiry?: string;
  urn?: string;
  __self__?: string;
}

export interface CreateHookOptions {
  event: string;
  callbackUrl: string;
  /** Folder URN (DM events) or project id (Issues events). */
  scopeValue: string;
  /** Arbitrary JSON echoed back in every callback. Must stay under 1 KB. */
  hookAttribute?: Record<string, unknown>;
  /** JSONPath filter, e.g. "$[?(@.ext=='rvt')]". */
  filter?: string;
  /** Let APS retry a deactivated hook after 7 days instead of leaving it dead. */
  autoReactivateHook?: boolean;
  region?: string;
}

export interface CreatedHook {
  hookId: string | undefined;
  system: WebhookSystem;
  event: string;
  scopeKey: 'folder' | 'project';
  scopeValue: string;
  callbackUrl: string;
  /** The raw Location header, kept for diagnosis when the id could not be parsed. */
  location: string | null;
}

// ---- Operations -------------------------------------------------------------

/**
 * Extract the hook id from the `Location` header of a create response.
 * Location looks like `.../events/{event}/hooks/{hookId}`; returns undefined if it does not.
 */
export function parseHookIdFromLocation(location: string | null): string | undefined {
  if (!location) return undefined;
  const match = /\/hooks\/([^/?#]+)\/?$/.exec(location.trim());
  return match?.[1];
}

/**
 * Create a webhook. Returns `201` with an empty body, so the id comes from `Location`.
 * A duplicate (same callbackUrl + scope + event) is rejected by APS with `409`.
 */
export async function createHook(
  auth: AuthProvider,
  options: CreateHookOptions,
): Promise<CreatedHook> {
  const { system, scopeKey } = systemForEvent(options.event);

  const body: Record<string, unknown> = {
    callbackUrl: options.callbackUrl,
    scope: { [scopeKey]: options.scopeValue },
  };
  if (options.hookAttribute) body['hookAttribute'] = options.hookAttribute;
  if (options.filter) body['filter'] = options.filter;
  if (options.autoReactivateHook !== undefined) {
    body['autoReactivateHook'] = options.autoReactivateHook;
  }

  const resp = await apsRequestDetailed<unknown>(
    auth,
    `${WEBHOOKS_BASE}/systems/${system}/events/${encodeURIComponent(options.event)}/hooks`,
    {
      method: 'POST',
      body,
      ...(options.region !== undefined ? { region: options.region } : {}),
    },
  );

  const location = resp.headers.get('location');
  return {
    hookId: parseHookIdFromLocation(location),
    system,
    event: options.event,
    scopeKey,
    scopeValue: options.scopeValue,
    callbackUrl: options.callbackUrl,
    location,
  };
}

export interface ListHooksResult {
  hooks: WebhookHook[];
  /** Cursor for the next page — pass back as `pageState`. Undefined when exhausted. */
  next?: string;
}

/**
 * List every hook this application created (2-legged only — the endpoint is defined for
 * client-credentials tokens). Answers `204` with no body when there are none.
 *
 * Only lists hooks in the region the request is made under.
 */
export async function listAppHooks(
  auth: AuthProvider,
  options: { status?: 'active' | 'inactive'; pageState?: string; region?: string } = {},
): Promise<ListHooksResult> {
  const resp = await apsRequestDetailed<{
    links?: { next?: string };
    data?: WebhookHook[];
  }>(auth, `${WEBHOOKS_BASE}/app/hooks`, {
    params: {
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.pageState !== undefined ? { pageState: options.pageState } : {}),
    },
    ...(options.region !== undefined ? { region: options.region } : {}),
  });

  // 204 = no hooks. Not an error, and there is no body to read.
  if (resp.status === 204 || resp.data === undefined) return { hooks: [] };

  const next = extractPageState(resp.data.links?.next);
  return {
    hooks: resp.data.data ?? [],
    ...(next !== undefined ? { next } : {}),
  };
}

/**
 * `links.next` is documented as an opaque cursor, but APS has returned it both bare and as
 * a full URL carrying `pageState=`. Accept either so pagination does not break on the shape.
 */
function extractPageState(next: string | undefined): string | undefined {
  if (!next) return undefined;
  if (!next.includes('://')) return next;
  try {
    return new URL(next).searchParams.get('pageState') ?? undefined;
  } catch {
    return next;
  }
}

/** Fetch a single hook. */
export async function getHook(
  auth: AuthProvider,
  event: string,
  hookId: string,
  region?: string,
): Promise<WebhookHook> {
  const { system } = systemForEvent(event);
  return apsRequest<WebhookHook>(
    auth,
    `${WEBHOOKS_BASE}/systems/${system}/events/${encodeURIComponent(event)}/hooks/${encodeURIComponent(hookId)}`,
    { ...(region !== undefined ? { region } : {}) },
  );
}

/** Delete a hook. APS answers `204`; there is nothing to parse. */
export async function deleteHook(
  auth: AuthProvider,
  event: string,
  hookId: string,
  region?: string,
): Promise<void> {
  const { system } = systemForEvent(event);
  await apsRequestDetailed<unknown>(
    auth,
    `${WEBHOOKS_BASE}/systems/${system}/events/${encodeURIComponent(event)}/hooks/${encodeURIComponent(hookId)}`,
    { method: 'DELETE', ...(region !== undefined ? { region } : {}) },
  );
}

// ---- Callback signature verification ----------------------------------------

/** Header carrying the HMAC signature on every delivered callback. */
export const SIGNATURE_HEADER = 'x-adsk-signature';
/** Header carrying a unique id per delivery attempt — use it to de-duplicate. */
export const DELIVERY_ID_HEADER = 'x-adsk-delivery-id';

/**
 * Verify the `x-adsk-signature` of a delivered webhook callback.
 *
 * APS signs with **HMAC-SHA1** (not SHA-256) and prefixes the hex digest with `sha1hash=`.
 *
 * `rawBody` must be the exact bytes received. Parsing the JSON and re-stringifying it
 * changes key order and whitespace, and the signature will never match — capture the raw
 * body before any JSON body-parser runs.
 *
 * Returns false rather than throwing, so a bad signature is a routing decision, not an
 * exception path. Comparison is length-safe and constant-time.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;

  const expected =
    'sha1hash=' +
    createHmac('sha1', secret)
      .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody)
      .digest('hex');

  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(signatureHeader, 'utf-8');
  // timingSafeEqual throws on length mismatch, which would itself leak length via the
  // exception — check length first and return the same false either way.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Shape of the JSON APS POSTs to a callback URL. */
export interface WebhookCallbackPayload {
  version?: string;
  resourceUrn?: string;
  hook?: Partial<WebhookHook>;
  payload?: Record<string, unknown>;
}
