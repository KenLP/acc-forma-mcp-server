import { gunzipSync } from 'node:zlib';
import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';
import { stripBPrefix } from '../utils/project-id.js';
import { assertAllowedUrl } from '../utils/url-guard.js';

const APS_BASE = 'https://developer.api.autodesk.com';

// ── S3 resource download bounds ──────────────────────────────────────────────
//
// The three clash resource files (clash / clash-instance / document) are each a SINGLE
// JSON object, not NDJSON — there is no line boundary to stream-parse against, so unlike
// Model Properties' NDJSON downloads these are still read fully into memory before
// JSON.parse. What changed: a fetch timeout, and a byte cap enforced while reading (not
// just via the optional Content-Length header) so a stalled or oversized download cannot
// pin memory/sockets on the 256MB Fly instance (see fly.toml).

/** Signed S3 URLs are only valid ~60s from when `resources` returned them (see CLAUDE.md),
 *  and up to 3 are fetched sequentially. 15s per file leaves margin for all three to finish
 *  inside that window; a resource that hasn't arrived by then isn't going to before the URL
 *  expires anyway, so there is nothing gained by waiting longer. */
const MC_RESOURCE_FETCH_TIMEOUT_MS = 15_000;

/** Hard cap on bytes read per resource file, applied both to the transferred (wire) bytes and
 *  as `zlib.gunzipSync`'s `maxOutputLength` on the decompressed bytes (a compressed response
 *  could expand far past its transferred size — this bounds that too, i.e. it also functions
 *  as a decompression-bomb guard). Sized well under the 256MB box to leave headroom for the
 *  rest of the request (three resources are downloaded one at a time, not concurrently, so
 *  only one buffer of this size is live at once). */
const MAX_CLASH_RESOURCE_BYTES = 25 * 1024 * 1024;

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
 * `maxOutputLength` bounds the decompressed size regardless of how small the compressed
 * bytes were (decompression-bomb guard) — see MAX_CLASH_RESOURCE_BYTES above.
 */
export function decodeResource(buf: Buffer, maxOutputLength = MAX_CLASH_RESOURCE_BYTES): string {
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const text = isGzip
    ? gunzipSync(buf, { maxOutputLength }).toString('utf-8')
    : buf.toString('utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Read a Web ReadableStream fully into a Buffer, counting bytes as they arrive and aborting
 * once `maxBytes` is exceeded — rather than trusting (optional, spoofable) Content-Length or
 * buffering an unbounded response via `arrayBuffer()`. Exported for unit testing with a
 * synthetic ReadableStream — no network involved.
 */
export async function readCappedBuffer(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `Model Coordination resource download exceeded the ${maxBytes}-byte cap (aborted after ${total} bytes) — refusing to keep buffering.`,
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  reader.releaseLock();
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
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
    assertAllowedUrl(r.url, { hostSuffixes: ['.amazonaws.com'] });
    let dl: Response;
    try {
      dl = await fetch(r.url, { signal: AbortSignal.timeout(MC_RESOURCE_FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(
          `Model Coordination resource download timed out after ${MC_RESOURCE_FETCH_TIMEOUT_MS}ms (signed URL TTL ~60s, type=${r.type})`,
        );
      }
      throw err;
    }
    if (!dl.ok) continue;
    const contentLength = dl.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_CLASH_RESOURCE_BYTES) {
      throw new Error(
        `Model Coordination resource (type=${r.type}) declares ${contentLength} bytes, exceeding the ${MAX_CLASH_RESOURCE_BYTES}-byte cap — refusing to download.`,
      );
    }
    const buf = dl.body
      ? await readCappedBuffer(dl.body, MAX_CLASH_RESOURCE_BYTES)
      : Buffer.from(await dl.arrayBuffer());
    const json = JSON.parse(decodeResource(buf)) as Record<string, unknown>;
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
