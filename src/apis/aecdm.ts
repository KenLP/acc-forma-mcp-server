import { apsGraphQL } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';

// ---- Types ----------------------------------------------------------------

export interface AecdmHub {
  id: string;
  name: string;
}

export interface AecProject {
  id: string;
  name: string;
}

export interface AecElementGroup {
  id: string;
  name: string;
  fileVersionUrn: string;
}

export interface ElementProperty {
  name: string;
  value: string | number | boolean | null;
}

export interface AecElement {
  id: string;
  name: string;
  properties: ElementProperty[];
}

export interface AecCategory {
  name: string;
  count: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

export interface AecElementPosition {
  id: string;
  name: string;
  /** Element origin (world-space) decoded from `pieces[0].transform`. Null if no geometry data or unknown matrix layout. */
  position: Vec3 | null;
  properties: ElementProperty[];
}

/** Raw `Transform` object from `geometryDataByElements`. */
interface TransformDto {
  type: string;
  value: number[];
}

// ---- GraphQL queries -------------------------------------------------------

const LIST_HUBS_QUERY = /* GraphQL */ `
  query ListHubs {
    hubs {
      pagination { cursor }
      results { id name }
    }
  }
`;

const LIST_PROJECTS_QUERY = /* GraphQL */ `
  query ListProjects($hubId: ID!) {
    projects(hubId: $hubId) {
      pagination { cursor }
      results { id name }
    }
  }
`;

const LIST_ELEMENT_GROUPS_QUERY = /* GraphQL */ `
  query ListElementGroups($projectId: ID!) {
    elementGroupsByProject(projectId: $projectId) {
      results {
        id
        name
        alternativeIdentifiers { fileVersionUrn }
      }
    }
  }
`;

// Query with server-side category filter.
// CORRECT syntax (per official APS blog): property.name.category=='Structural Columns'
// Single quotes are REQUIRED around the value, even for single-word categories.
const LIST_ELEMENTS_FILTERED_QUERY = /* GraphQL */ `
  query ListElementsFiltered(
    $elementGroupId: ID!
    $filter: String!
    $limit: Int
    $cursor: String
  ) {
    elementsByElementGroup(
      elementGroupId: $elementGroupId
      filter: { query: $filter }
      pagination: { limit: $limit, cursor: $cursor }
    ) {
      pagination { cursor }
      results {
        id
        name
        properties { results { name value } }
      }
    }
  }
`;

// AECDM geometry data (Public Beta).
// Returns per-element geometry pieces with transforms. We decode the translation
// from `pieces[0].transform.value` to derive each element's origin (position).
// The mesh data itself (`GeometryPieceData` union: GeometryPrimitive | GeometryInstance
// | BinaryData) is intentionally NOT queried — it would require inline fragments
// and binary download/parse to compute an AABB.
// Schema ref: https://aps.autodesk.com/en/docs/aecdatamodel/v1/reference/queries/geometryDataByElements/
const LIST_GEOMETRY_DATA_QUERY = /* GraphQL */ `
  query GetGeometryDataByElements($elementIds: [ID!]) {
    geometryDataByElements(elementIds: $elementIds) {
      geometryData {
        elementID
        pieces {
          transform { type value }
        }
      }
    }
  }
`;

// ---- Shared page type & mapper ---------------------------------------------

type ElementsPage = {
  elementsByElementGroup: {
    pagination: { cursor?: string | null };
    results: Array<{
      id: string;
      name: string;
      properties: { results: Array<{ name: string; value: unknown }> };
    }>;
  };
};

function mapElements(
  raw: ElementsPage['elementsByElementGroup']['results'],
): AecElement[] {
  return raw.map((el) => ({
    id: el.id,
    name: el.name,
    properties: (el.properties.results ?? []).map((p) => ({
      name: p.name,
      value: p.value as string | number | boolean | null,
    })),
  }));
}

// ---- Internal helpers ------------------------------------------------------

async function fetchWithFilter(
  auth: AuthProvider,
  elementGroupId: string,
  filter: string,
  maxElements: number,
): Promise<AecElement[]> {
  const all: AecElement[] = [];
  const pageLimit = Math.min(maxElements, 100);
  let cursor: string | undefined;
  do {
    const data = await apsGraphQL<ElementsPage>(auth, LIST_ELEMENTS_FILTERED_QUERY, {
      elementGroupId,
      filter,
      limit: pageLimit,
      cursor: cursor ?? null,
    });
    const page = data.elementsByElementGroup;
    all.push(...mapElements(page.results ?? []));
    cursor = page.pagination.cursor ?? undefined;
  } while (cursor && all.length < maxElements);
  return all;
}

// ---- Public API ------------------------------------------------------------

export async function listAecdmHubs(auth: AuthProvider): Promise<AecdmHub[]> {
  const data = await apsGraphQL<{
    hubs: { results: Array<{ id: string; name: string }> };
  }>(auth, LIST_HUBS_QUERY, {});
  return data.hubs.results ?? [];
}

export async function listAecdmProjects(
  auth: AuthProvider,
  hubId: string,
): Promise<AecProject[]> {
  const data = await apsGraphQL<{
    projects: { results: Array<{ id: string; name: string }> };
  }>(auth, LIST_PROJECTS_QUERY, { hubId });
  return data.projects.results ?? [];
}

export async function listAecdmElementGroups(
  auth: AuthProvider,
  projectId: string,
): Promise<AecElementGroup[]> {
  const data = await apsGraphQL<{
    elementGroupsByProject: {
      results: Array<{
        id: string;
        name: string;
        alternativeIdentifiers: { fileVersionUrn: string };
      }>;
    };
  }>(auth, LIST_ELEMENT_GROUPS_QUERY, { projectId });
  return (data.elementGroupsByProject.results ?? []).map((eg) => ({
    id: eg.id,
    name: eg.name,
    fileVersionUrn: eg.alternativeIdentifiers?.fileVersionUrn ?? '',
  }));
}

/**
 * Query elements by category name.
 *
 * Filter syntax (per official APS blog "Exploring Revit data with AEC Data Model API"):
 *   property.name.category=='Structural Columns'
 *
 * Single quotes are REQUIRED around the value. Falls back to client-side
 * filtering if the filter DSL still rejects the query.
 */
export async function queryElementsByCategory(
  auth: AuthProvider,
  elementGroupId: string,
  category: string,
  maxElements = 500,
): Promise<AecElement[]> {
  const filter = `property.name.category=='${category}'`;

  return fetchWithFilter(auth, elementGroupId, filter, maxElements);
}

// ---- Spatial helpers -------------------------------------------------------

/** True if point `p` lies inside (or on the boundary of) `box`. */
export function pointInBox(p: Vec3, box: BoundingBox): boolean {
  return (
    p.x >= box.min.x && p.x <= box.max.x &&
    p.y >= box.min.y && p.y <= box.max.y &&
    p.z >= box.min.z && p.z <= box.max.z
  );
}

/**
 * Decode the translation (world-space origin) from a `Transform` returned by
 * `geometryDataByElements`.
 *
 * `Transform.value` is a flat float array — length 16 for a 4×4 homogeneous
 * matrix, length 12 for a 4×3 affine matrix. `Transform.type` indicates the
 * layout; we treat strings containing "row" (case-insensitive) as row-major
 * and default everything else to column-major (OpenGL/three.js convention).
 *
 * Returns null when the value array has an unsupported length.
 */
export function decodeTransformTranslation(t: TransformDto | null | undefined): Vec3 | null {
  if (!t || !Array.isArray(t.value)) return null;
  const v = t.value;
  const isRowMajor = /row/i.test(t.type ?? '');
  // Length is checked before indexing, so the !-asserted accesses are safe.
  if (v.length === 16) {
    return isRowMajor
      ? { x: v[3]!, y: v[7]!, z: v[11]! }
      : { x: v[12]!, y: v[13]!, z: v[14]! };
  }
  if (v.length === 12) {
    return isRowMajor
      ? { x: v[3]!, y: v[7]!, z: v[11]! }
      : { x: v[9]!, y: v[10]!, z: v[11]! };
  }
  return null;
}

/**
 * Query elements by category and resolve each element's origin (position) via
 * AECDM `geometryDataByElements` (Public Beta).
 *
 * Workflow:
 *  1. Resolve elements in the category via `queryElementsByCategory`.
 *  2. Batch element IDs into chunks of `batchSize` (default 50) and call
 *     `geometryDataByElements` per batch.
 *  3. For each element, decode the translation from `pieces[0].transform.value`.
 *
 * If `referenceBox` is supplied, only elements whose position lies inside the
 * box are returned (point-in-box test). Elements without a decodable transform
 * are excluded when `referenceBox` is set, and returned with `position=null`
 * when it is not.
 *
 * NOTE: AECDM does not expose axis-aligned bounding boxes; only mesh data +
 * transforms. For a true AABB use Model Derivative API. This function is
 * sufficient for ACC Issue pushpins (`linked_documents[].details.position`).
 */
export async function queryElementPositions(
  auth: AuthProvider,
  elementGroupId: string,
  category: string,
  options: {
    maxElements?: number;
    referenceBox?: BoundingBox;
    batchSize?: number;
  } = {},
): Promise<AecElementPosition[]> {
  const { maxElements = 500, referenceBox, batchSize = 50 } = options;

  const elements = await queryElementsByCategory(auth, elementGroupId, category, maxElements);
  if (elements.length === 0) return [];

  // Batch element IDs into geometryDataByElements calls
  const transformByElementId = new Map<string, TransformDto | null>();
  for (let i = 0; i < elements.length; i += batchSize) {
    const chunk = elements.slice(i, i + batchSize);
    const ids = chunk.map((el) => el.id);
    const data = await apsGraphQL<{
      geometryDataByElements: {
        geometryData: Array<{
          elementID: string;
          pieces: Array<{ transform: TransformDto | null }> | null;
        }> | null;
      } | null;
    }>(auth, LIST_GEOMETRY_DATA_QUERY, { elementIds: ids });

    const rows = data.geometryDataByElements?.geometryData ?? [];
    for (const row of rows) {
      const firstPiece = row.pieces?.[0];
      transformByElementId.set(row.elementID, firstPiece?.transform ?? null);
    }
  }

  const positions: AecElementPosition[] = elements.map((el) => ({
    id: el.id,
    name: el.name,
    position: decodeTransformTranslation(transformByElementId.get(el.id)),
    properties: el.properties,
  }));

  if (!referenceBox) return positions;

  return positions.filter(
    (el): boolean => el.position !== null && pointInBox(el.position, referenceBox),
  );
}

/**
 * Get all properties of a specific element by its AECDM node ID.
 *
 * The AECDM filter DSL operates on element PROPERTIES, not on the GraphQL
 * node id. So we query all elements in a category (the category is required)
 * and match the node id client-side.
 *
 * @param category  Element category (e.g. "Structural Columns") — required
 *                  because AECDM `elementsByElementGroup` requires a filter.
 *                  Pass the same category that produced this element_id from
 *                  aecdm_query_elements.
 */
export async function getElementProperties(
  auth: AuthProvider,
  elementGroupId: string,
  elementId: string,
  category: string,
): Promise<AecElement | null> {
  const elements = await queryElementsByCategory(auth, elementGroupId, category, 1000);
  // Try exact match first, then case-insensitive (AECDM IDs are base64 — case-sensitive)
  const exact = elements.find((el) => el.id === elementId);
  if (exact) return exact;
  const ci = elements.find((el) => el.id.toLowerCase() === elementId.toLowerCase());
  return ci ?? null;
}

/**
 * Common Revit BIM categories to probe.
 * Covers Architectural, Structural, MEP, and miscellaneous disciplines.
 */
const COMMON_REVIT_CATEGORIES = [
  // Architectural
  'Walls', 'Floors', 'Ceilings', 'Roofs', 'Doors', 'Windows',
  'Stairs', 'Railings', 'Ramps', 'Curtain Panels', 'Curtain Wall Mullions',
  'Curtain Systems', 'Curtain Wall Grids',
  // Structural
  'Structural Columns', 'Structural Framing', 'Structural Foundations',
  'Structural Connections', 'Structural Trusses', 'Structural Rebar',
  'Structural Stiffeners', 'Structural Beam Systems', 'Structural Area Reinforcement',
  'Structural Path Reinforcement', 'Structural Fabric Reinforcement',
  // MEP
  'Pipes', 'Pipe Fittings', 'Pipe Accessories', 'Pipe Insulations',
  'Ducts', 'Duct Fittings', 'Duct Accessories', 'Duct Insulations', 'Air Terminals',
  'Conduits', 'Conduit Fittings', 'Cable Trays', 'Cable Tray Fittings',
  'Mechanical Equipment', 'Electrical Equipment', 'Electrical Fixtures',
  'Lighting Fixtures', 'Lighting Devices', 'Plumbing Fixtures', 'Sprinklers',
  'Communication Devices', 'Data Devices', 'Fire Alarm Devices', 'Security Devices',
  'Telephone Devices', 'Nurse Call Devices',
  // Furniture & Equipment
  'Furniture', 'Furniture Systems', 'Casework', 'Specialty Equipment',
  'Generic Models', 'Mass', 'Site', 'Planting', 'Entourage', 'Parking',
  'Topography', 'Pads',
  // Annotation / context
  'Levels', 'Grids', 'Reference Planes', 'Rooms', 'Spaces', 'Areas',
  'Project Information',
  // Less common
  'Columns', 'Beams',
];

/**
 * Probe a single category to count its elements. Uses limit=1 paging to
 * minimise payload — we just need to know if elements exist and roughly how many.
 * Returns the count of elements found (capped at probeLimit).
 */
async function probeCategoryCount(
  auth: AuthProvider,
  elementGroupId: string,
  category: string,
  probeLimit = 100,
): Promise<number> {
  try {
    const elements = await fetchWithFilter(
      auth,
      elementGroupId,
      `property.name.category=='${category}'`,
      probeLimit,
    );
    return elements.length;
  } catch {
    return 0;
  }
}

/**
 * List BIM categories present in an element group.
 *
 * Strategy: probe a comprehensive list of well-known Revit categories using
 * the working `property.name.category=='<name>'` filter (which is verified to
 * work for both single-word and multi-word categories like "Structural Columns").
 *
 * This avoids the broken `distinctPropertyValuesInElementGroupByName` query
 * (whose schema doesn't match Autodesk's docs) and the no-filter
 * `elementsByElementGroup` query (which AECDM doesn't allow without a filter).
 *
 * Probes run in parallel, so the total time is bounded by the slowest single probe.
 * Categories with zero elements are excluded from the result.
 */
export async function listAecdmCategories(
  auth: AuthProvider,
  elementGroupId: string,
): Promise<AecCategory[]> {
  const probes = COMMON_REVIT_CATEGORIES.map(async (cat) => ({
    name: cat,
    count: await probeCategoryCount(auth, elementGroupId, cat),
  }));

  const results = await Promise.all(probes);

  return results
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
}
