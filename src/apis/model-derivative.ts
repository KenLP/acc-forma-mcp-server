import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';

// ── URN helpers ───────────────────────────────────────────────────────────────

/** Encode a raw APS URN to base64url for use in MD API path segments. */
export function encodeMdUrn(urn: string): string {
  if (!urn.includes(':')) return urn; // already encoded
  return Buffer.from(urn).toString('base64url');
}

/** Decode a base64url MD URN back to the raw form. */
export function decodeMdUrn(encoded: string): string {
  if (encoded.includes(':')) return encoded; // already raw
  try {
    return Buffer.from(encoded, 'base64url').toString('utf-8');
  } catch {
    return encoded;
  }
}

// ── Shared types ──────────────────────────────────────────────────────────────

export type MdStatus = 'pending' | 'inprogress' | 'success' | 'failed' | 'timeout';

export interface MdDerivativeChild {
  guid: string;
  type: string;
  role: string;
  name?: string;
  status?: string;
  /**
   * ACC Docs-native viewable id. Present on `geometry` nodes; it is the **stable, human-meaningful**
   * id the markups/issues service keys on (e.g. "Layout1" for a DWG layout, a page id for a PDF),
   * NOT the SVF2 `guid`. The viewer surfaces this as a viewable's `viewableID`.
   */
  viewableID?: string;
  children?: MdDerivativeChild[];
}

export interface MdDerivative {
  name?: string;
  outputType: string;
  status: string;
  progress?: string;
  children?: MdDerivativeChild[];
}

export interface MdManifest {
  urn: string;
  status: MdStatus;
  progress: string;
  region?: string;
  derivatives: MdDerivative[];
}

export interface MdView {
  guid: string;
  name: string;
  role: '2d' | '3d';
}

export interface MdBoundingBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface MdElement {
  objectId: number;
  name: string;
  externalId: string;
  category?: string;
  bbox?: MdBoundingBox;
  /**
   * Projected Revit parameters requested via `GetMdPropertiesOptions.fields`
   * (e.g. {"Level": "L3", "Base Constraint": "L1 - Block 35", "Area": "465.6 ft^2"}).
   * MD/SVF2 exposes the FULL Revit parameter set — including Level/Constraint/Area —
   * which AECDM omits. Keyed by the actual parameter name found.
   */
  properties?: Record<string, unknown>;
}

export interface MdTranslationJob {
  result: string;
  urn: string;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function getMdManifest(auth: AuthProvider, urn: string): Promise<MdManifest> {
  return apsRequest<MdManifest>(
    auth,
    `/modelderivative/v2/designdata/${encodeMdUrn(urn)}/manifest`,
  );
}

export async function getMdViews(auth: AuthProvider, urn: string): Promise<MdView[]> {
  const resp = await apsRequest<{
    data: { metadata: Array<{ guid: string; name: string; role: string }> };
  }>(auth, `/modelderivative/v2/designdata/${encodeMdUrn(urn)}/metadata`);
  return (resp.data?.metadata ?? []).map((m) => ({
    guid: m.guid,
    name: m.name,
    role: m.role === '2d' ? '2d' : '3d',
  }));
}

// ── Docs-native viewables (for ACC markups / TwoDRasterPushpin) ─────────────────

/**
 * A viewable surfaced for ACC Docs markups. The key field is `viewableId` (the manifest
 * `viewableID`) — that is what `TwoDRasterPushpin.details.viewable.viewableId` must reference.
 * The SVF2 `guid` is also surfaced for completeness (vector/3D pins use it), but the markups
 * service REJECTS a bare SVF2 guid for a raster PDF pin.
 */
export interface DocsViewable {
  /**
   * ACC Docs-native viewable id (manifest `viewableID`). e.g. "Layout1" for a DWG layout,
   * a page id for a PDF. Pass this as `TwoDRasterPushpin` `viewableId`. Absent when the
   * derivative node has no `viewableID` — then only the SVF2 `guid` exists, which is not
   * accepted for raster PDF pins.
   */
  viewableId?: string;
  /** Human-readable sheet / view / page label. */
  name: string;
  /** Model Derivative SVF2 GUID. For vector/3D pins only — rejected by raster PDF pins. */
  guid: string;
  role: '2d' | '3d';
  /** Derivative output type this viewable came from (e.g. "svf2"). */
  outputType: string;
}

/**
 * Walk a Model Derivative manifest and collect every geometry viewable (2D and 3D) across
 * all derivatives, surfacing the Docs-native `viewableID`. This is the data the ACC viewer
 * uses to build a TwoDRasterPushpin — `md_get_manifest` only surfaces `guid`/`name` and
 * therefore cannot produce a working raster-pin `viewableId`.
 */
export function extractDocsViewables(manifest: MdManifest): DocsViewable[] {
  const out: DocsViewable[] = [];

  function walk(children: MdDerivativeChild[] | undefined, outputType: string): void {
    for (const child of children ?? []) {
      if (child.type === 'geometry' && (child.role === '2d' || child.role === '3d')) {
        out.push({
          ...(child.viewableID ? { viewableId: child.viewableID } : {}),
          name: child.name ?? 'unnamed',
          guid: child.guid,
          role: child.role === '2d' ? '2d' : '3d',
          outputType,
        });
      }
      if (child.children) walk(child.children, outputType);
    }
  }

  for (const d of manifest.derivatives ?? []) walk(d.children, d.outputType);
  return out;
}

// ── Properties ────────────────────────────────────────────────────────────────

interface RawPropertiesResp {
  data?: { collection?: RawElement[] };
  pagination?: { cursor?: string };
}

interface RawElement {
  objectid: number;
  name: string;
  externalId: string;
  properties?: Record<string, Record<string, unknown>>;
}

function parseBbox(raw: unknown): MdBoundingBox | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const p = parsed as Record<string, Record<string, number>>;
    const mn = p['min'];
    const mx = p['max'];
    if (!mn || !mx) return undefined;
    return {
      min: { x: mn['x'] ?? 0, y: mn['y'] ?? 0, z: mn['z'] ?? 0 },
      max: { x: mx['x'] ?? 0, y: mx['y'] ?? 0, z: mx['z'] ?? 0 },
    };
  } catch {
    return undefined;
  }
}

function extractCategory(props: Record<string, Record<string, unknown>>): string | undefined {
  // Common locations in Revit SVF2
  const fromElement = props['Element']?.['Category'] as string | undefined;
  if (fromElement) return fromElement;
  const fromIdData = props['Identity Data']?.['Category'] as string | undefined;
  if (fromIdData) return fromIdData;
  // Fallback: scan all property groups for any 'Category' key
  for (const group of Object.values(props)) {
    if (group && typeof group === 'object') {
      const cat = group['Category'] as string | undefined;
      if (cat && typeof cat === 'string' && cat.length > 0) return cat;
    }
  }
  return undefined;
}

export interface GetMdPropertiesOptions {
  viewGuid?: string;
  categoryFilter?: string;
  objectIds?: number[];
  maxResults?: number;
  /**
   * Revit parameter names to project onto each element (case-insensitive; searched
   * across all property groups). Enables grouping/quantity analysis the LLM can do
   * in one call — e.g. fields ["Level","Area"] for floors, ["Base Constraint","Area"]
   * for walls. Mirrors a field projection: keeps the payload lean vs the full tree.
   */
  fields?: string[];
}

/**
 * Find a single Revit parameter in an MD property tree (groups → fields).
 * Exact (case-insensitive) match preferred; falls back to the first substring match.
 * Returns the actual key found plus its value, or undefined.
 */
function findParam(
  props: Record<string, Record<string, unknown>>,
  name: string,
): { key: string; value: unknown } | undefined {
  const fl = name.toLowerCase();
  let fuzzy: { key: string; value: unknown } | undefined;
  for (const group of Object.values(props)) {
    if (!group || typeof group !== 'object') continue;
    for (const [k, v] of Object.entries(group)) {
      const kl = k.toLowerCase();
      if (kl === fl) return { key: k, value: v };
      if (!fuzzy && kl.includes(fl)) fuzzy = { key: k, value: v };
    }
  }
  return fuzzy;
}

/**
 * Project requested parameter names from an MD property tree (groups → fields).
 * Returns a flat map keyed by the actual parameter name found.
 */
function projectFields(
  props: Record<string, Record<string, unknown>>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const hit = findParam(props, field);
    if (hit) out[hit.key] = hit.value;
  }
  return out;
}

/** Stringify a scalar MD parameter value for use as a group key. */
function scalarToString(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '(none)';
}

/** Coerce an MD parameter value to a number — handles raw numbers and unit-suffixed strings ("465.6 ft^2"). */
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (m) {
      const n = parseFloat(m[0]);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

interface MdTreeNode {
  objectid?: number;
  name?: string;
  objects?: MdTreeNode[];
}

/**
 * Build an `objectId → category` map from the MD object tree. Revit SVF2 nests every
 * element under a category node (a child of the "Model" root) — e.g. "Walls", "Floors",
 * "Doors". This is the reliable category source; the flat /properties response has none.
 */
export async function getMdCategoryMap(
  auth: AuthProvider,
  urn: string,
  viewGuid: string,
): Promise<Map<number, string>> {
  const encoded = encodeMdUrn(urn);
  const resp = await apsRequest<{ data?: { objects?: MdTreeNode[] } }>(
    auth,
    `/modelderivative/v2/designdata/${encoded}/metadata/${viewGuid}`,
    { params: { forceget: true } },
  );
  const map = new Map<number, string>();
  for (const root of resp.data?.objects ?? []) {
    for (const catNode of root.objects ?? []) {
      const cat = catNode.name ?? '';
      const stack: MdTreeNode[] = [catNode];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (typeof n.objectid === 'number') map.set(n.objectid, cat);
        for (const child of n.objects ?? []) stack.push(child);
      }
    }
  }
  return map;
}

export async function getMdProperties(
  auth: AuthProvider,
  urn: string,
  opts: GetMdPropertiesOptions = {},
): Promise<MdElement[]> {
  const encoded = encodeMdUrn(urn);
  const { categoryFilter, objectIds, maxResults = 200, fields } = opts;

  let guid = opts.viewGuid;
  if (!guid) {
    const views = await getMdViews(auth, urn);
    const view3d = views.find((v) => v.role === '3d') ?? views[0];
    if (!view3d) throw new Error('No views in derivative — translate the model first (md_trigger_translation).');
    guid = view3d.guid;
  }

  // The flat /properties response has NO category field, so name/property matching is
  // unreliable (esp. floors named "Concrete Slab…", or plural-vs-singular). The object
  // TREE nests every element under its category node — the reliable category source.
  const categoryMap = categoryFilter ? await getMdCategoryMap(auth, urn, guid) : undefined;

  const elements: MdElement[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string | number | boolean | undefined> = { forceget: true };
    if (cursor) params['pageState'] = cursor;

    const resp = await apsRequest<RawPropertiesResp>(
      auth,
      `/modelderivative/v2/designdata/${encoded}/metadata/${guid}/properties`,
      { params },
    );

    for (const raw of resp.data?.collection ?? []) {
      if (elements.length >= maxResults) break;
      if (objectIds && !objectIds.includes(raw.objectid)) continue;

      const props = raw.properties ?? {};
      // Prefer the tree-derived category (reliable); fall back to property scan.
      const category = categoryMap?.get(raw.objectid) ?? extractCategory(props);
      if (categoryFilter) {
        const catLower = categoryFilter.toLowerCase();
        const catMatch = category !== undefined && category.toLowerCase().includes(catLower);
        const nameMatch = raw.name.toLowerCase().includes(catLower);
        if (!catMatch && !nameMatch) continue;
      }

      // __boundingBox__ lives inside the __internal__ group in some Revit SVF2 translations.
      // Not present in MEP/linked-file elements — check withBbox count in results.
      const bboxRaw = props['__internal__']?.['__boundingBox__'];

      const parsed = parseBbox(bboxRaw);
      const el: MdElement = {
        objectId: raw.objectid,
        name: raw.name,
        externalId: raw.externalId,
      };
      if (category !== undefined) el.category = category;
      if (parsed !== undefined) el.bbox = parsed;
      if (fields && fields.length > 0) {
        const projected = projectFields(props, fields);
        if (Object.keys(projected).length > 0) el.properties = projected;
      }
      elements.push(el);
    }

    cursor = elements.length < maxResults ? (resp.pagination?.cursor) : undefined;
  } while (cursor);

  return elements;
}

// ── Server-side aggregation (group + sum) ──────────────────────────────────────

export interface MdAggregateGroup {
  /** Group value (e.g. a level name "L3"), or "(no <field>)" when the element lacks it. */
  group: string;
  /** Number of elements in this group. */
  count: number;
  /** Summed value per requested numeric field (e.g. {"Area": 12626.4}). */
  sums: Record<string, number>;
}

export interface MdAggregateResult {
  groups: MdAggregateGroup[];
  /** Elements that matched the category filter and were grouped. */
  totalCount: number;
  /** Grand total per summed field across all groups. */
  grandTotals: Record<string, number>;
  groupByField: string;
  sumFields: string[];
  /** Total elements scanned from the model (before category filtering). */
  scanned: number;
  /** True if the scan hit the maxScan safety cap (results may be partial). */
  truncated: boolean;
}

export interface AggregateMdOptions {
  viewGuid?: string;
  categoryFilter?: string;
  /** Parameter to group by (e.g. "Level" for floors, "Base Constraint" for walls). */
  groupBy: string;
  /** Numeric parameters to sum within each group. Defaults to ["Area"]. */
  sumFields?: string[];
  /** Safety cap on elements scanned. Defaults to 100000 (covers any real model). */
  maxScan?: number;
}

/**
 * Group ALL elements of a category by a Revit parameter and sum numeric fields, server-side.
 *
 * Unlike `getMdProperties` (which caps at `maxResults` and the tool only displays the first 30),
 * this paginates through the ENTIRE model and returns a compact per-group rollup — so "total floor
 * area per level" covers every floor in the building, not a 30-element sample. This is the reliable
 * way to answer take-off questions without dumping thousands of rows into context.
 */
export async function aggregateMdProperties(
  auth: AuthProvider,
  urn: string,
  opts: AggregateMdOptions,
): Promise<MdAggregateResult> {
  const encoded = encodeMdUrn(urn);
  const { categoryFilter, groupBy } = opts;
  const sumFields = opts.sumFields && opts.sumFields.length > 0 ? opts.sumFields : ['Area'];
  const maxScan = opts.maxScan ?? 100000;

  let guid = opts.viewGuid;
  if (!guid) {
    const views = await getMdViews(auth, urn);
    const view3d = views.find((v) => v.role === '3d') ?? views[0];
    if (!view3d) throw new Error('No views in derivative — translate the model first (md_trigger_translation).');
    guid = view3d.guid;
  }

  const categoryMap = categoryFilter ? await getMdCategoryMap(auth, urn, guid) : undefined;

  const groups = new Map<string, { count: number; sums: Record<string, number> }>();
  let scanned = 0;
  let matched = 0;
  let truncated = false;
  let cursor: string | undefined;

  do {
    const params: Record<string, string | number | boolean | undefined> = { forceget: true };
    if (cursor) params['pageState'] = cursor;

    const resp = await apsRequest<RawPropertiesResp>(
      auth,
      `/modelderivative/v2/designdata/${encoded}/metadata/${guid}/properties`,
      { params },
    );

    for (const raw of resp.data?.collection ?? []) {
      if (scanned >= maxScan) { truncated = true; break; }
      scanned++;

      const props = raw.properties ?? {};
      const category = categoryMap?.get(raw.objectid) ?? extractCategory(props);
      if (categoryFilter) {
        const catLower = categoryFilter.toLowerCase();
        const catMatch = category !== undefined && category.toLowerCase().includes(catLower);
        const nameMatch = raw.name.toLowerCase().includes(catLower);
        if (!catMatch && !nameMatch) continue;
      }

      const gp = findParam(props, groupBy);
      const groupKey = gp ? scalarToString(gp.value) : `(no ${groupBy})`;
      matched++;

      let g = groups.get(groupKey);
      if (!g) { g = { count: 0, sums: {} }; groups.set(groupKey, g); }
      g.count++;
      for (const sf of sumFields) {
        const hit = findParam(props, sf);
        const n = hit ? toNumber(hit.value) : undefined;
        if (n !== undefined) g.sums[sf] = (g.sums[sf] ?? 0) + n;
      }
    }

    cursor = scanned < maxScan ? resp.pagination?.cursor : undefined;
  } while (cursor);

  const groupArr: MdAggregateGroup[] = Array.from(groups.entries())
    .map(([group, v]) => ({ group, count: v.count, sums: v.sums }))
    .sort((a, b) => b.count - a.count);

  const grandTotals: Record<string, number> = {};
  for (const g of groupArr) {
    for (const [k, v] of Object.entries(g.sums)) grandTotals[k] = (grandTotals[k] ?? 0) + v;
  }

  return {
    groups: groupArr,
    totalCount: matched,
    grandTotals,
    groupByField: groupBy,
    sumFields,
    scanned,
    truncated,
  };
}

// ── Translation job ───────────────────────────────────────────────────────────

export async function triggerMdTranslation(
  auth: AuthProvider,
  urn: string,
  forceRegenerate = false,
): Promise<MdTranslationJob> {
  return apsRequest<MdTranslationJob>(auth, '/modelderivative/v2/designdata/job', {
    method: 'POST',
    body: {
      input: {
        urn: encodeMdUrn(urn),
        ...(forceRegenerate ? { compressedUrn: false } : {}),
      },
      output: {
        formats: [
          {
            type: 'svf2',
            views: ['2d', '3d'],
            advanced: { generateMasterViews: true },
          },
        ],
      },
    },
  });
}
