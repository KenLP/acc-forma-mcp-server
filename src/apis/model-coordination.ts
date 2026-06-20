import { gunzipSync } from 'node:zlib';
import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';
import { stripBPrefix } from '../utils/project-id.js';

const APS_BASE = 'https://developer.api.autodesk.com';

// ---- Types ------------------------------------------------------------------

export interface ModelSet {
  modelSetId: string;
  name: string;
  isDisabled: boolean;
  clashEngineVersion?: number;
  includedFolderCount?: number;
  createdTime?: string;
}

export interface ModelSetVersion {
  version: number;
  status: string;
  documentVersions?: Array<{ stableDocumentId?: string; unstableDocumentId?: string }>;
}

export interface ClashTest {
  id: string;
  status: string;
  modelSetVersion: number;
  completedOn?: string;
  backendType?: string;
}

/** A document (model) participating in the clash test. `id` is referenced by clash instances. */
export interface ClashDocument {
  id: number;
  urn: string; // file version URN
  viewableName: string;
}

// Raw shapes inside the downloaded resource files (single JSON object each).
interface RawClash {
  id: number;
  clash: [number, number]; // [leftObjectId, rightObjectId]
  dist: number; // negative = penetration depth (hard clash)
  status: number;
}
interface RawInstance {
  cid: number; // clash id
  ldid: number; // left document index
  loid: number; // left object id
  lvid: number; // left viewer (lmv/dbId)
  rdid: number; // right document index
  roid: number;
  rvid: number;
}

export interface ClashSide {
  /** File version URN of the model this element belongs to. */
  documentUrn: string;
  /** 3D view name in the coordination (e.g. "{3D}", "3D Plumbing"). */
  viewableName: string;
  /** Model object id (stable within the translation). */
  objectId: number;
  /** Viewer dbId (lmv id) — usable as a pushpin objectId in the same viewable. */
  lmvId: number;
}

export interface ResolvedClash {
  clashId: number;
  /** Negative = penetration depth (hard clash); the magnitude is the overlap in model units. */
  distance: number;
  /** Raw MC status code (1 = active/new in observed data). */
  status: number;
  left: ClashSide;
  right: ClashSide;
}

export interface ClashResultsOptions {
  version?: number;
  /** Keep only clashes with this raw status code. */
  status?: number;
  /** Keep only clashes whose |distance| ≥ this (filter out grazing/near clashes). */
  minPenetration?: number;
  maxResults?: number;
}

// ---- Pure join logic (unit-tested) -----------------------------------------

/**
 * Join the three clash resource arrays into resolved clash pairs.
 * Each clash is matched to its first instance (element identities + document indices),
 * and each document index is resolved to its URN + viewable name.
 * Sorted by distance ascending (most-negative penetration first).
 */
export function resolveClashes(
  clashes: RawClash[],
  instances: RawInstance[],
  documents: ClashDocument[],
  opts: ClashResultsOptions = {},
): ResolvedClash[] {
  const docById = new Map(documents.map((d) => [d.id, d]));
  const instByCid = new Map<number, RawInstance>();
  for (const inst of instances) if (!instByCid.has(inst.cid)) instByCid.set(inst.cid, inst);

  const out: ResolvedClash[] = [];
  for (const c of clashes) {
    if (opts.status !== undefined && c.status !== opts.status) continue;
    if (opts.minPenetration !== undefined && Math.abs(c.dist) < opts.minPenetration) continue;
    const inst = instByCid.get(c.id);
    if (!inst) continue; // no instance → cannot resolve element identity
    const ld = docById.get(inst.ldid);
    const rd = docById.get(inst.rdid);
    out.push({
      clashId: c.id,
      distance: c.dist,
      status: c.status,
      left: { documentUrn: ld?.urn ?? '', viewableName: ld?.viewableName ?? '', objectId: inst.loid, lmvId: inst.lvid },
      right: { documentUrn: rd?.urn ?? '', viewableName: rd?.viewableName ?? '', objectId: inst.roid, lmvId: inst.rvid },
    });
  }
  out.sort((a, b) => a.distance - b.distance);
  return opts.maxResults ? out.slice(0, opts.maxResults) : out;
}

// ---- API calls --------------------------------------------------------------

export async function listModelSets(auth: AuthProvider, projectId: string): Promise<ModelSet[]> {
  const c = stripBPrefix(projectId);
  const data = await apsRequest<{ modelSets?: ModelSet[] }>(
    auth,
    `/bim360/modelset/v3/containers/${c}/modelsets`,
    { baseUrl: APS_BASE },
  );
  return data.modelSets ?? [];
}

export async function getLatestModelSetVersion(
  auth: AuthProvider,
  projectId: string,
  modelSetId: string,
): Promise<ModelSetVersion> {
  const c = stripBPrefix(projectId);
  return apsRequest<ModelSetVersion>(
    auth,
    `/bim360/modelset/v3/containers/${c}/modelsets/${modelSetId}/versions/latest`,
    { baseUrl: APS_BASE },
  );
}

export async function listClashTests(
  auth: AuthProvider,
  projectId: string,
  modelSetId: string,
  version: number,
): Promise<ClashTest[]> {
  const c = stripBPrefix(projectId);
  const data = await apsRequest<{ tests?: ClashTest[] }>(
    auth,
    `/bim360/clash/v3/containers/${c}/modelsets/${modelSetId}/versions/${version}/tests`,
    { baseUrl: APS_BASE },
  );
  return data.tests ?? [];
}

/**
 * undici auto-decompresses by Content-Encoding; only gunzip when still gzip magic (1f 8b).
 * The clash resource files are UTF-8 with a leading BOM — strip it so JSON.parse succeeds.
 */
function decodeResource(buf: Buffer): string {
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const text = isGzip ? gunzipSync(buf).toString('utf-8') : buf.toString('utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface ClashResults {
  modelSetId: string;
  version: number;
  testId: string | null;
  testStatus: string | null;
  documents: ClashDocument[];
  totalClashes: number;
  clashes: ResolvedClash[];
}

/**
 * Resolve clashes for a modelset: get the latest (or given) version's clash test,
 * download its three resource files (signed S3 URLs, ~60s TTL — fetched immediately),
 * and join them into resolved clash pairs.
 */
export async function getClashResults(
  auth: AuthProvider,
  projectId: string,
  modelSetId: string,
  opts: ClashResultsOptions = {},
): Promise<ClashResults> {
  const c = stripBPrefix(projectId);
  const version = opts.version ?? (await getLatestModelSetVersion(auth, projectId, modelSetId)).version;

  const tests = await listClashTests(auth, projectId, modelSetId, version);
  const test = tests.find((t) => t.status === 'Success') ?? tests[0];
  if (!test) {
    return { modelSetId, version, testId: null, testStatus: null, documents: [], totalClashes: 0, clashes: [] };
  }

  const resData = await apsRequest<{ resources?: Array<{ type: string; url: string }> }>(
    auth,
    `/bim360/clash/v3/containers/${c}/tests/${test.id}/resources`,
    { baseUrl: APS_BASE },
  );

  let clashes: RawClash[] = [];
  let instances: RawInstance[] = [];
  let documents: ClashDocument[] = [];
  for (const r of resData.resources ?? []) {
    // Pre-signed S3 URL — fetch WITHOUT the APS bearer token.
    const dl = await fetch(r.url);
    if (!dl.ok) continue;
    const json = JSON.parse(decodeResource(Buffer.from(await dl.arrayBuffer()))) as Record<string, unknown>;
    if (r.type.includes('clash-instance')) instances = (json['instances'] as RawInstance[]) ?? [];
    else if (r.type.includes('document')) documents = (json['documents'] as ClashDocument[]) ?? [];
    else if (r.type.includes('clash')) clashes = (json['clashes'] as RawClash[]) ?? [];
  }

  return {
    modelSetId,
    version,
    testId: test.id,
    testStatus: test.status,
    documents,
    totalClashes: clashes.length,
    clashes: resolveClashes(clashes, instances, documents, opts),
  };
}
