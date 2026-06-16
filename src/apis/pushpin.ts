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
  /** Pin position in VIEWER space (run the AECDM origin through `aecdmPositionToViewer` first). */
  position: Vec3;
  /** SVF dbId. Resolve by matching the element's External ID against `md_get_properties`. */
  objectId?: number;
  /** Revit UniqueId — the AECDM "External ID" property. The robust element anchor. */
  externalId?: string;
  /** Version of the model the pin was created against. */
  createdAtVersion?: number;
}

/**
 * Assemble a `linkedDocuments[]` entry for a 3D model pushpin.
 *
 * IMPORTANT: ACC 3D model pins use `type: "TwoDVectorPushpin"` with
 * `details.viewable.is3D = true` — NOT "ThreeDVectorPushpin". This is confirmed from
 * a working pin placed via the ACC UI; using "ThreeDVectorPushpin" can fail to render.
 */
export function buildPushpin(opts: BuildPushpinOptions): LinkedDocument {
  return {
    type: 'TwoDVectorPushpin',
    urn: opts.lineageUrn,
    ...(opts.createdAtVersion !== undefined ? { createdAtVersion: opts.createdAtVersion } : {}),
    details: {
      viewable: { guid: opts.viewableGuid, is3D: true },
      position: opts.position,
      ...(opts.objectId !== undefined ? { objectId: opts.objectId } : {}),
      ...(opts.externalId !== undefined ? { externalId: opts.externalId } : {}),
    },
  };
}

// ── 2D PDF raster pushpins ──────────────────────────────────────────────────

/** Default Docs origin context for a PDF-sheet pin (product=docs, tool=files). */
export const DOCS_FILES_PLACEMENT = {
  originContext: { product: 'docs', tool: 'files' },
} as const;

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
   * ACC Docs-native viewable id (e.g. "Layout1"). This is NOT a Model Derivative
   * SVF2 GUID — the markups service rejects SVF2 GUIDs for raster PDF pins.
   */
  viewableId: string;
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
   * Origin-context placements. Defaults to the Docs files context
   * (`{ product: "docs", tool: "files" }`), which is what the ACC UI sends.
   */
  placements?: LinkedDocument['placements'];
}

/**
 * Assemble a `linkedDocuments[]` entry for a pin on a 2D PDF sheet.
 *
 * The contract differs from 3D pins (proven against issue displayId 1 in the test
 * project — a working hand-placed PDF pin):
 *   - `type: "TwoDRasterPushpin"`         (NOT TwoDVectorPushpin)
 *   - `position: { x, y }`                normalized 0–1, top-left origin, NO z
 *   - `viewable.viewableId: "Layout1"`    an ACC Docs-native viewable (NOT an SVF2 GUID)
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
    placements: opts.placements ?? [{ ...DOCS_FILES_PLACEMENT }],
    details: {
      viewable: {
        viewableId: opts.viewableId,
        is3D: false,
        ...(opts.viewableName !== undefined ? { name: opts.viewableName } : {}),
      },
      position: { x: opts.position.x, y: opts.position.y },
    },
  };
}
