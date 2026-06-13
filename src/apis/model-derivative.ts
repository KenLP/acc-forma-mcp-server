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
  return (
    (props['Element']?.['Category'] as string | undefined) ??
    (props['Identity Data']?.['Category'] as string | undefined) ??
    undefined
  );
}

export interface GetMdPropertiesOptions {
  viewGuid?: string;
  categoryFilter?: string;
  objectIds?: number[];
  maxResults?: number;
}

export async function getMdProperties(
  auth: AuthProvider,
  urn: string,
  opts: GetMdPropertiesOptions = {},
): Promise<MdElement[]> {
  const encoded = encodeMdUrn(urn);
  const { categoryFilter, objectIds, maxResults = 200 } = opts;

  let guid = opts.viewGuid;
  if (!guid) {
    const views = await getMdViews(auth, urn);
    const view3d = views.find((v) => v.role === '3d') ?? views[0];
    if (!view3d) throw new Error('No views in derivative — translate the model first (md_trigger_translation).');
    guid = view3d.guid;
  }

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
      const category = extractCategory(props);
      if (categoryFilter && category && !category.toLowerCase().includes(categoryFilter.toLowerCase())) continue;

      // __boundingBox__ lives inside the __internal__ category in Revit SVF2
      const bboxRaw = props['__internal__']?.['__boundingBox__'];

      const parsed = parseBbox(bboxRaw);
      const el: MdElement = {
        objectId: raw.objectid,
        name: raw.name,
        externalId: raw.externalId,
      };
      if (category !== undefined) el.category = category;
      if (parsed !== undefined) el.bbox = parsed;
      elements.push(el);
    }

    cursor = elements.length < maxResults ? (resp.pagination?.cursor) : undefined;
  } while (cursor);

  return elements;
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
