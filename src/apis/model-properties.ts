import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';
import { stripBPrefix } from '../utils/project-id.js';
import { assertAllowedUrl } from '../utils/url-guard.js';

// ── Model Properties API (index v2) — version diff ──────────────────────────────
//
// The backend of ACC's "Compare Versions" feature. Given two versions of the SAME
// file lineage it computes, server-side, which design elements were added / removed /
// modified between them — including whether a change is a transform (move/rotate) or a
// geometry change, plus every property value before/after. No viewer needed.
//
// Flow (verified live with SSA — 3LO is NOT required):
//   1. POST  /construction/index/v2/projects/{pid}/diffs:batch-status   → diffId (async)
//   2. GET   /construction/index/v2/projects/{pid}/diffs/{diffId}        → poll until FINISHED
//   3. GET   .../diffs/{diffId}/fields       (NDJSON: p-hash key → human name/category)
//      GET   .../diffs/{diffId}/properties   (NDJSON: one row per changed element)
//
// Requirement: element IDs must be STABLE between the two versions (same design objects)
// — true for consecutive Revit/DWG/NWC/IFC versions of one file.

const APS_BASE = 'https://developer.api.autodesk.com';

export interface DiffStats {
  added: number;
  removed: number;
  modified: number;
}

export interface VersionDiffStatus {
  diffId: string;
  /** PROCESSING | FINISHED | FAILED (raw MP state string). */
  state: string;
  stats?: DiffStats;
  manifestUrl?: string;
  fieldsUrl?: string;
  propertiesUrl?: string;
  prevVersionUrns: string[];
  curVersionUrns: string[];
}

interface RawDiffRecord {
  diffId: string;
  state: string;
  stats?: DiffStats;
  manifestUrl?: string;
  fieldsUrl?: string;
  propertiesUrl?: string;
  prevVersionUrns?: string[];
  curVersionUrns?: string[];
}

function toStatus(r: RawDiffRecord): VersionDiffStatus {
  const out: VersionDiffStatus = {
    diffId: r.diffId,
    state: r.state,
    prevVersionUrns: r.prevVersionUrns ?? [],
    curVersionUrns: r.curVersionUrns ?? [],
  };
  if (r.stats) out.stats = r.stats;
  if (r.manifestUrl) out.manifestUrl = r.manifestUrl;
  if (r.fieldsUrl) out.fieldsUrl = r.fieldsUrl;
  if (r.propertiesUrl) out.propertiesUrl = r.propertiesUrl;
  return out;
}

/** Kick off (or look up — the call is idempotent per version pair) a version diff. */
export async function createVersionDiff(
  auth: AuthProvider,
  projectId: string,
  prevVersionUrn: string,
  curVersionUrn: string,
): Promise<VersionDiffStatus> {
  const pid = stripBPrefix(projectId);
  const resp = await apsRequest<{ diffs: RawDiffRecord[] }>(
    auth,
    `/construction/index/v2/projects/${pid}/diffs:batch-status`,
    {
      baseUrl: APS_BASE,
      method: 'POST',
      body: { diffs: [{ prevVersionUrn, curVersionUrn }] },
      // Idempotent per version pair — a repeated call returns the same cached diffId, so
      // retrying a 5xx here cannot create a duplicate.
      retryOn5xx: true,
    },
  );
  const rec = resp.diffs?.[0];
  if (!rec) throw new Error('Model Properties diff returned an empty response.');
  return toStatus(rec);
}

/** Poll a diff by id. */
export async function getVersionDiff(
  auth: AuthProvider,
  projectId: string,
  diffId: string,
): Promise<VersionDiffStatus> {
  const pid = stripBPrefix(projectId);
  const rec = await apsRequest<RawDiffRecord>(
    auth,
    `/construction/index/v2/projects/${pid}/diffs/${diffId}`,
    { baseUrl: APS_BASE },
  );
  return toStatus(rec);
}

// ── NDJSON downloads (fields + properties) ──────────────────────────────────────
//
// The Fly instance this server runs on has only 256MB RAM (see fly.toml). These downloads
// used to `await r.text()` the WHOLE response before parsing a single line, and `properties`
// applied `maxElements` only after every row was already parsed — the cap did nothing for
// peak memory. Both are now bounded:
//   - a hard fetch timeout (a stalled download must not pin the connection/memory forever)
//   - a byte cap enforced WHILE reading (Content-Length is checked up front when present,
//     but it's optional/spoofable, so bytes are also counted per chunk as they arrive)
//   - line-at-a-time streaming parse, so a `maxLines` cap (used for the `maxElements`
//     property cap) stops the download itself instead of trimming an already-parsed array

/** Regular JSON round-trip calls use 30s (see http/client.ts); these are file downloads that
 *  can run to several MB, so they get more headroom — but still bounded, since a stalled
 *  connection must not hold memory/sockets open indefinitely on a 256MB instance. */
const NDJSON_FETCH_TIMEOUT_MS = 45_000;

/** Hard cap on bytes read from an NDJSON response. `maxElements` (default 2000) already stops
 *  the `properties` download early in the common case; this is the backstop for the `fields`
 *  download (which has no element cap) and for any pathological response. 25MiB of NDJSON text
 *  can expand to several times that once parsed into JS objects (V8 object overhead), so this
 *  is sized to leave headroom on the 256MB box even in the worst case. */
const MAX_NDJSON_RESPONSE_BYTES = 25 * 1024 * 1024;

/** Parse a decoded chunk into complete lines plus a leftover partial line ("carry") — a chunk
 *  boundary can split a JSON row in half, so the tail is held back and prefixed onto the next
 *  chunk before splitting again. Pure and unit-tested independent of any network stream. */
function splitNdjsonLines(carry: string, chunkText: string): { lines: string[]; carry: string } {
  const parts = (carry + chunkText).split(/\r?\n/);
  const nextCarry = parts.pop() ?? '';
  return { lines: parts, carry: nextCarry };
}

interface NdjsonReadResult {
  rows: Record<string, unknown>[];
  /** True if reading stopped early because `maxLines` was reached (stream may have more). */
  truncated: boolean;
}

/**
 * Stream-parse NDJSON from a Web ReadableStream: decode → split into lines → parse each line
 * immediately, stopping as soon as `maxLines` rows have been collected (cancelling the
 * underlying reader instead of continuing to buffer). Also enforces `maxBytes` on the raw
 * bytes read so far, independent of any Content-Length header. Exported for unit testing with
 * a synthetic ReadableStream — no network involved.
 */
export async function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  options: { maxLines?: number; maxBytes: number },
): Promise<NdjsonReadResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const rows: Record<string, unknown>[] = [];
  let carry = '';
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > options.maxBytes) {
        throw new Error(
          `Model Properties download exceeded the ${options.maxBytes}-byte cap (aborted after ${bytesRead} bytes) — refusing to keep buffering.`,
        );
      }
      const { lines, carry: nextCarry } = splitNdjsonLines(carry, decoder.decode(value, { stream: true }));
      carry = nextCarry;
      for (const line of lines) {
        const t = line.trim();
        if (t) rows.push(JSON.parse(t) as Record<string, unknown>);
        if (options.maxLines !== undefined && rows.length >= options.maxLines) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (!truncated) {
      const t = carry.trim();
      if (t) rows.push(JSON.parse(t) as Record<string, unknown>);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }

  if (truncated) {
    // We have all the rows we need — release the connection instead of draining the rest.
    await reader.cancel().catch(() => {});
  } else {
    reader.releaseLock();
  }
  return { rows, truncated };
}

async function fetchNdjson(
  auth: AuthProvider,
  url: string,
  options: { maxLines?: number } = {},
): Promise<Record<string, unknown>[]> {
  // Bearer goes only to the declared APS host — never to an arbitrary URL from a response.
  assertAllowedUrl(url, { exactHosts: ['developer.api.autodesk.com'] });
  const token = await auth.getAccessToken();
  let r: Response;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(NDJSON_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`Model Properties download timed out after ${NDJSON_FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Model Properties download failed ${r.status}: ${body.slice(0, 200)}`);
  }
  const contentLength = r.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_NDJSON_RESPONSE_BYTES) {
    throw new Error(
      `Model Properties download declares ${contentLength} bytes, exceeding the ${MAX_NDJSON_RESPONSE_BYTES}-byte cap — refusing to download.`,
    );
  }
  if (!r.body) return [];
  const { rows } = await readNdjsonStream(r.body, {
    ...(options.maxLines !== undefined ? { maxLines: options.maxLines } : {}),
    maxBytes: MAX_NDJSON_RESPONSE_BYTES,
  });
  return rows;
}

export interface DiffField {
  key: string;
  name: string;
  category: string;
}

/** Download the fields index → map of p-hash key → {name, category}. */
export async function downloadDiffFields(
  auth: AuthProvider,
  fieldsUrl: string,
): Promise<Map<string, DiffField>> {
  const rows = await fetchNdjson(auth, fieldsUrl);
  const map = new Map<string, DiffField>();
  for (const r of rows) {
    const key = r['key'] as string | undefined;
    if (!key) continue;
    map.set(key, {
      key,
      name: (r['name'] as string) ?? key,
      category: (r['category'] as string) ?? '',
    });
  }
  return map;
}

export type DiffChangeKind = 'ADDED' | 'REMOVED' | 'CHANGED';

/** A single parameter whose value differs between the two versions. */
export interface PropChange {
  field: string;
  category: string;
  prev: unknown;
  cur: unknown;
}

export interface DiffElement {
  /** Normalized change kind. */
  kind: DiffChangeKind;
  /** Raw MP changeType for CHANGED rows — e.g. "Transform" (moved/rotated) or "Geometry". */
  changeType?: string;
  category?: string;
  name?: string;
  externalId?: string;
  /** Viewer dbId (lmv) — anchor for pinning / viewer highlight. */
  lmvId?: number;
  svf2Id?: number;
  /** For CHANGED rows: the parameters whose value changed (old → new). */
  changes?: PropChange[];
}

// Internal MP field-categories to ignore when diffing property values (graph plumbing,
// not user-meaningful). __name__ (rename) and __category__ (recategorize) are KEPT.
const INTERNAL_CATEGORY_SKIP = new Set([
  '__parent__', '__instanceof__', '__hastable__', '__viewable_in__',
  '__externalref__', '__document__', '__hyperlink__', '__node_flags__',
]);

/** Diff cur vs prev property maps → the list of changed parameters, resolved to human names. */
function computeChanges(
  cur: Record<string, unknown>,
  prev: Record<string, unknown>,
  fields: Map<string, DiffField>,
  cap = 25,
): PropChange[] {
  const out: PropChange[] = [];
  for (const [key, curVal] of Object.entries(cur)) {
    if (out.length >= cap) break;
    if (!(key in prev)) continue;
    const prevVal = prev[key];
    if (asStr(prevVal) === asStr(curVal)) continue;
    const f = fields.get(key);
    if (f && INTERNAL_CATEGORY_SKIP.has(f.category)) continue;
    out.push({
      field: f?.name ?? key,
      category: f?.category ?? '',
      prev: prevVal,
      cur: curVal,
    });
  }
  return out;
}

const KIND_MAP: Record<string, DiffChangeKind> = {
  OBJECT_ADDED: 'ADDED',
  OBJECT_REMOVED: 'REMOVED',
  OBJECT_CHANGED: 'CHANGED',
};

function findKey(fields: Map<string, DiffField>, pred: (f: DiffField) => boolean): string | undefined {
  for (const f of fields.values()) if (pred(f)) return f.key;
  return undefined;
}

/** Stringify a scalar prop value; objects are JSON-encoded rather than "[object Object]". */
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '';
}

/**
 * Download the per-element diff rows and resolve each into a compact DiffElement,
 * using the fields map to turn p-hash keys into name/category.
 */
export async function downloadDiffProperties(
  auth: AuthProvider,
  propertiesUrl: string,
  fields: Map<string, DiffField>,
  maxElements = 2000,
): Promise<DiffElement[]> {
  // maxLines stops the download itself at maxElements rows — it does not parse the rest of
  // the response and then trim, which is what let peak memory scale with the full model.
  const rows = await fetchNdjson(auth, propertiesUrl, { maxLines: maxElements });

  // The name/category keys are internal fields, stable across models.
  const nameKey = findKey(fields, (f) => f.category === '__name__');
  const catKey = findKey(fields, (f) => f.category === '__category__');

  const out: DiffElement[] = [];
  for (const row of rows) {
    const rawType = row['type'] as string | undefined;
    const kind = (rawType ? KIND_MAP[rawType] : undefined) ?? 'CHANGED';

    // OBJECT_REMOVED rows carry props:null — the element's data lives under `prev`.
    const prev = row['prev'] as Record<string, unknown> | undefined;
    const curProps = (row['props'] as Record<string, unknown> | null) ?? {};
    const prevProps = (prev?.['props'] as Record<string, unknown> | null) ?? {};
    const props = Object.keys(curProps).length > 0 ? curProps : prevProps;

    const el: DiffElement = { kind };
    const ct = row['changeType'];
    if (typeof ct === 'string') el.changeType = ct;
    const eid = row['externalId'];
    if (typeof eid === 'string') el.externalId = eid;
    const lmv = row['lmvId'] ?? prev?.['lmvId'];
    if (typeof lmv === 'number') el.lmvId = lmv;
    const s2 = row['svf2Id'];
    if (typeof s2 === 'number') el.svf2Id = s2;

    if (nameKey && props[nameKey] != null) el.name = asStr(props[nameKey]);
    if (catKey && props[catKey] != null) {
      // The internal __category__ value is prefixed, e.g. "Revit Walls" → "Walls".
      el.category = asStr(props[catKey]).replace(/^Revit\s+/i, '');
    }

    // For CHANGED rows, surface which parameters actually changed (old → new).
    if (kind === 'CHANGED' && Object.keys(prevProps).length > 0) {
      const changes = computeChanges(curProps, prevProps, fields);
      if (changes.length > 0) el.changes = changes;
    }

    out.push(el);
  }
  return out;
}

export interface DiffCategoryRollup {
  category: string;
  added: number;
  removed: number;
  changed: number;
  total: number;
}

export interface DiffRollup {
  byCategory: DiffCategoryRollup[];
  /** Distribution of CHANGED rows by changeType (Transform / Geometry / …). */
  byChangeType: Record<string, number>;
}

/** Roll up resolved diff elements by category and by change type — the routing signal for alerts. */
export function rollupDiff(elements: DiffElement[]): DiffRollup {
  const cats = new Map<string, DiffCategoryRollup>();
  const byChangeType: Record<string, number> = {};

  for (const el of elements) {
    const cat = el.category ?? '(uncategorized)';
    let c = cats.get(cat);
    if (!c) {
      c = { category: cat, added: 0, removed: 0, changed: 0, total: 0 };
      cats.set(cat, c);
    }
    if (el.kind === 'ADDED') c.added++;
    else if (el.kind === 'REMOVED') c.removed++;
    else c.changed++;
    c.total++;

    if (el.kind === 'CHANGED' && el.changeType) {
      byChangeType[el.changeType] = (byChangeType[el.changeType] ?? 0) + 1;
    }
  }

  const byCategory = Array.from(cats.values()).sort((a, b) => b.total - a.total);
  return { byCategory, byChangeType };
}
