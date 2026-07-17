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

async function fetchNdjson(auth: AuthProvider, url: string): Promise<Record<string, unknown>[]> {
  // Bearer goes only to the declared APS host — never to an arbitrary URL from a response.
  assertAllowedUrl(url, { exactHosts: ['developer.api.autodesk.com'] });
  const token = await auth.getAccessToken();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Model Properties download failed ${r.status}: ${body.slice(0, 200)}`);
  }
  const text = await r.text();
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t) as Record<string, unknown>);
  }
  return out;
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
  const rows = await fetchNdjson(auth, propertiesUrl);

  // The name/category keys are internal fields, stable across models.
  const nameKey = findKey(fields, (f) => f.category === '__name__');
  const catKey = findKey(fields, (f) => f.category === '__category__');

  const out: DiffElement[] = [];
  for (const row of rows) {
    if (out.length >= maxElements) break;
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
