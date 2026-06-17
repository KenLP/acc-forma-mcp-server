import type { LinkedDocument } from './issues.js';

/**
 * ACC Issue pushpin coordinate helpers.
 *
 * Proven against ground truth: issue #24 "Quality_Door" in the Ken-MCP project — a
 * 3D pin placed by hand via the ACC UI on the El Cabrillo sample door
 * (External ID 5b72d515-…-0027fac7). Reading that pin back and comparing to the
 * SAME door's AECDM position gave:
 *
 *   AECDM position (m):            (1.1441, -8.5012, 0.0000)
 *   AECDM × 3.280839895 (ft):      (3.7536, -27.8911, 0.0000)
 *   stored pin + globalOffset:     (3.5790, -27.9110, 4.3275)
 *   Δ x = 0.17 ft, Δ y = 0.02 ft   ← essentially exact (human click offset)
 *
 * Conclusions:
 *  - AECDM `geometryDataByElements` returns geometry in **metres**, always.
 *  - The ACC viewer for an imperial Revit model is in **feet** → scale by 3.280839895.
 *  - The stored pin position is in **viewer space** = global − globalOffset.
 *  - `globalOffset` is a per-model viewer constant (read it once from any existing
 *    pin's `viewerState.globalOffset`, then reuse for all auto-generated pins).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** AECDM geometry is always in metres. Multiply by this for an imperial (feet) viewer. */
export const METERS_TO_FEET = 3.280839895;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Convert an AECDM element origin (metres) into an ACC viewer pushpin position.
 *
 *   viewer = aecdm_metres × unitFactor − globalOffset
 *
 * @param aecdmPositionMeters origin from `aecdm_query_element_positions` (metres).
 * @param globalOffset        the viewer globalOffset for THIS model. Read it from an
 *                            existing pin (`viewerState.globalOffset`). Defaults to
 *                            (0,0,0), which yields *global* coordinates — off by the
 *                            real offset until calibrated.
 * @param unitFactor          metres → viewer unit. 3.280839895 for imperial (feet,
 *                            the default), 1 for metres, 1000 for millimetres.
 */
export function aecdmPositionToViewer(
  aecdmPositionMeters: Vec3,
  globalOffset: Vec3 = ZERO,
  unitFactor: number = METERS_TO_FEET,
): Vec3 {
  return {
    x: aecdmPositionMeters.x * unitFactor - globalOffset.x,
    y: aecdmPositionMeters.y * unitFactor - globalOffset.y,
    z: aecdmPositionMeters.z * unitFactor - globalOffset.z,
  };
}

export interface BuildPushpinOptions {
  /** DM lineage URN of the model the pin attaches to (urn:adsk.…:dm.lineage:…). */
  lineageUrn: string;
  /** 3D viewable GUID from `md_get_manifest`. */
  viewableGuid: string;
  /**
   * 3D view name from `md_get_manifest` (e.g. "{3D}", "3D Plumbing"). REQUIRED — the
   * ACC Issues API rejects a pin whose `details.viewable` has no `name` with HTTP 400
   * `ISSUES_SERVICE_BAD_REQUEST` ("must have required property 'name'").
   */
  viewableName: string;
  /**
   * ACC Docs-native 3D viewable ID from the manifest `viewableID` field (e.g.
   * "bb5eff03-9b0b-4912-a74c-a723242f0b4b-002c43bd"). Required for the ACC viewer to
   * route the issue to the correct 3D view; without it the pin exists but the viewer
   * cannot navigate to it. Get from `extractDocsViewables` as `chosen.viewableId`.
   */
  viewableId?: string;
  /** Pin position in VIEWER space (run the AECDM origin through `aecdmPositionToViewer` first). */
  position: Vec3;
  /** SVF dbId. Resolve by matching the element's External ID against `md_get_properties`. */
  objectId?: number;
  /** Revit UniqueId — the AECDM "External ID" property. The robust element anchor. */
  externalId?: string;
  /** Version of the model the pin was created against. */
  createdAtVersion?: number;
  /**
   * Viewer globalOffset for this model. When provided, a `viewerState` is included in
   * the pin — required for ACC to open the correct view when the user clicks the issue.
   */
  globalOffset?: Vec3;
  /**
   * URL-safe base64 of the model version URN (no padding). Becomes `viewerState.seedURN`.
   * Compute: `Buffer.from(versionUrn).toString('base64url')`.
   */
  seedUrn?: string;
}

/**
 * Build a minimal `viewerState` for a 3D pushpin. Modelled on the structure observed
 * in hand-placed working pin #102 from the Ken-MCP test project. The camera is placed
 * above and slightly offset so the target (= pin position) is centred in an orthographic view.
 */
function buildViewerState(position: Vec3, globalOffset: Vec3, seedUrn?: string): Record<string, unknown> {
  // Camera offset: 25 units back in -X, 75 units up in +Z — matches #102 reference.
  const ex = position.x - 25, ey = position.y, ez = position.z + 75;
  return {
    version: '2.0',
    ...(seedUrn !== undefined ? { seedURN: seedUrn } : {}),
    viewport: {
      name: '',
      eye: [ex, ey, ez],
      target: [position.x, position.y, position.z],
      up: [0.32, 0, 0.95],
      worldUpVector: [0, 0, 1],
      pivotPoint: [position.x, position.y, position.z],
      projection: 'orthographic',
      aspectRatio: 1.756,
      isOrthographic: true,
      distanceToOrbit: 79,
      orthographicHeight: 30,
    },
    cutplanes: [],
    floorGuid: null,
    objectSet: [
      {
        id: [],
        hidden: [],
        idType: 'lmv',
        isolated: [],
        explodeScale: 0,
        explodeOptions: { magnitude: 4, depthDampening: 0 },
      },
    ],
    globalOffset: { x: globalOffset.x, y: globalOffset.y, z: globalOffset.z },
    renderOptions: {
      toneMap: { method: 1, exposure: -7, lightMultiplier: -1e-20 },
      appearance: {
        ghostHidden: true,
        antiAliasing: true,
        displayLines: true,
        ambientShadow: true,
        displayPoints: true,
        swapBlackAndWhite: false,
        progressiveDisplay: true,
      },
      environment: 'Boardwalk',
      ambientOcclusion: { radius: 8, enabled: true, intensity: 1 },
    },
    autocam: {
      cubeFront: { x: 1, y: 0, z: 0 },
      sceneUpDirection: { x: 0, y: 0, z: 1 },
      sceneFrontDirection: { x: 0, y: 1, z: 0 },
    },
    floorOffsetMax: 0,
    floorOffsetMin: 0,
    floorLineageUrn: null,
    floorVersionUrn: null,
    attributesVersion: 2,
  };
}

/**
 * Assemble a `linkedDocuments[]` entry for a 3D model pushpin.
 *
 * IMPORTANT: ACC 3D model pins use `type: "TwoDVectorPushpin"` with
 * `details.viewable.is3D = true` — NOT "ThreeDVectorPushpin". This is confirmed from
 * a working pin placed via the ACC UI; using "ThreeDVectorPushpin" can fail to render.
 *
 * Pass `viewableId` (from `extractDocsViewables` → `chosen.viewableId`) and `globalOffset`
 * (+ `seedUrn`) to enable ACC viewer routing. Without them the pin exists in the API but
 * is not navigable — the viewer shows "This issue is unavailable."
 */
export function buildPushpin(opts: BuildPushpinOptions): LinkedDocument {
  return {
    type: 'TwoDVectorPushpin',
    urn: opts.lineageUrn,
    ...(opts.createdAtVersion !== undefined ? { createdAtVersion: opts.createdAtVersion } : {}),
    details: {
      viewable: {
        guid: opts.viewableGuid,
        name: opts.viewableName,
        is3D: true,
        ...(opts.viewableId !== undefined ? { viewableId: opts.viewableId } : {}),
      },
      position: opts.position,
      ...(opts.objectId !== undefined ? { objectId: opts.objectId } : {}),
      ...(opts.externalId !== undefined ? { externalId: opts.externalId } : {}),
      ...(opts.globalOffset !== undefined
        ? { viewerState: buildViewerState(opts.position, opts.globalOffset, opts.seedUrn) }
        : {}),
    },
  };
}

// ── 2D PDF raster pushpins ──────────────────────────────────────────────────

/** Default origin context for a Docs PDF-sheet pin: `{ product: "docs", tool: "files" }`. */
export const DOCS_ORIGIN_CONTEXT = { product: 'docs', tool: 'files' } as const;

/** @deprecated Use DOCS_ORIGIN_CONTEXT. */
export const DOCS_FILES_PLACEMENT = { originContext: DOCS_ORIGIN_CONTEXT } as const;

/** True when both components are finite and within the normalized 0–1 range (inclusive). */
export function isNormalized(p: Vec2): boolean {
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.x <= 1 &&
    p.y >= 0 &&
    p.y <= 1
  );
}

export interface BuildRasterPushpinOptions {
  /** DM lineage URN of the PDF the pin attaches to (urn:adsk.…:dm.lineage:…). */
  lineageUrn: string;
  /**
   * ACC Docs-native viewable id (e.g. "Layout1", or a page id like "1"). NOT a bare
   * Model Derivative SVF2 GUID — the markups service rejects a guid-only raster pin.
   */
  viewableId: string;
  /**
   * The SVF2 `guid` of the SAME 2D viewable node that carries `viewableId`
   * (from `docs_get_viewables`). **Strongly recommended — effectively required when a
   * document has multiple 2D nodes sharing one `viewableId`** (e.g. a PDF whose pages
   * all report `viewableId: "1"`). Without it ACC stores `guid: null`, cannot resolve
   * which viewable to anchor, fails to build the routing placement, and the issue shows
   * "This issue is unavailable. Adjust your filters and try again." in the document viewer.
   * Proven against issue #99 (broken: no guid) vs #1 (works: viewableId + guid).
   */
  guid?: string;
  /**
   * Pin position in NORMALIZED sheet coordinates: x,y in [0,1], top-left origin.
   * (0,0) is the top-left corner of the page, (1,1) the bottom-right.
   */
  position: Vec2;
  /** Optional human-readable viewable / page name. */
  viewableName?: string;
  /** Version of the PDF the pin was created against. */
  createdAtVersion?: number;
  /**
   * Origin context placed at the **top level** of the linked document (NOT inside a
   * nested `placements` array — that does not propagate to the issue's routing placement).
   * Defaults to `{ product: "docs", tool: "files" }`, which is what the ACC UI sends.
   */
  originContext?: LinkedDocument['originContext'];
}

/**
 * Assemble a `linkedDocuments[]` entry for a pin on a 2D PDF sheet.
 *
 * The contract differs from 3D pins (proven against issue displayId 1 in the test
 * project — a working hand-placed PDF pin):
 *   - `type: "TwoDRasterPushpin"`         (NOT TwoDVectorPushpin)
 *   - `position: { x, y }`                normalized 0–1, top-left origin, NO z
 *   - `viewable.viewableId: "Layout1"`    an ACC Docs-native viewable (NOT a bare SVF2 GUID)
 *   - `viewable.guid: "<2D node guid>"`   the matching 2D viewable's guid (from docs_get_viewables);
 *                                         needed to disambiguate documents whose pages share a viewableId
 *   - `placements: [{ originContext: { product: "docs", tool: "files" } }]`
 *
 * Throws if `position` is not normalized — sending out-of-range or 3D coordinates
 * makes the markups service reject the whole issue with HTTP 400
 * `ISSUES_SERVICE_FAILED_TO_UPDATE_MARKUPS` (and ACC rolls the issue back atomically).
 */
export function buildRasterPushpin(opts: BuildRasterPushpinOptions): LinkedDocument {
  if (!isNormalized(opts.position)) {
    throw new Error(
      `TwoDRasterPushpin position must be normalized 0–1 (top-left origin), got ` +
        `(${opts.position.x}, ${opts.position.y}). Divide pixel/PDF-point coordinates by the ` +
        `page width/height before placing a PDF pin.`,
    );
  }
  return {
    type: 'TwoDRasterPushpin',
    urn: opts.lineageUrn,
    ...(opts.createdAtVersion !== undefined ? { createdAtVersion: opts.createdAtVersion } : {}),
    originContext: opts.originContext ?? { ...DOCS_ORIGIN_CONTEXT },
    details: {
      viewable: {
        viewableId: opts.viewableId,
        ...(opts.guid !== undefined ? { guid: opts.guid } : {}),
        is3D: false,
        ...(opts.viewableName !== undefined ? { name: opts.viewableName } : {}),
      },
      position: { x: opts.position.x, y: opts.position.y },
    },
  };
}
