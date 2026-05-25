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

export interface AecElementWithBBox {
  id: string;
  name: string;
  bbox: BoundingBox | null;
  properties: ElementProperty[];
}

/** How to compare a candidate element's bbox against a reference bbox. */
export type SpatialMode = 'intersects' | 'inside' | 'contains';

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

// Query with geometry/boundingBox (AECDM beta field).
// Used for spatial queries — clash detection, inclusion checks, bbox listing.
const LIST_ELEMENTS_WITH_BBOX_QUERY = /* GraphQL */ `
  query ListElementsWithBBox(
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
        geometry {
          boundingBox {
            min { x y z }
            max { x y z }
          }
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

// ---- Spatial / bounding-box helpers ----------------------------------------

/** True if `a` and `b` overlap (touching counts as intersecting). */
export function bboxIntersects(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z
  );
}

/** True if `inner` is fully inside `outer`. */
export function bboxInside(inner: BoundingBox, outer: BoundingBox): boolean {
  return (
    inner.min.x >= outer.min.x && inner.max.x <= outer.max.x &&
    inner.min.y >= outer.min.y && inner.max.y <= outer.max.y &&
    inner.min.z >= outer.min.z && inner.max.z <= outer.max.z
  );
}

/**
 * Query elements with their bounding boxes (uses the AECDM beta `geometry` field).
 *
 * Optionally filter results by spatial relationship to a reference bbox:
 *  - 'intersects' — element bbox overlaps reference (clash detection)
 *  - 'inside'     — element bbox fully inside reference (containment query)
 *  - 'contains'   — element bbox fully contains reference
 *
 * Elements without geometry data are excluded when a spatial filter is set,
 * and returned with bbox=null when no filter is set.
 */
export async function queryElementBoundingBoxes(
  auth: AuthProvider,
  elementGroupId: string,
  category: string,
  options: {
    maxElements?: number;
    referenceBox?: BoundingBox;
    mode?: SpatialMode;
  } = {},
): Promise<AecElementWithBBox[]> {
  const { maxElements = 500, referenceBox, mode = 'intersects' } = options;
  const filter = `property.name.category=='${category}'`;
  const pageLimit = Math.min(maxElements, 100);

  const all: AecElementWithBBox[] = [];
  let cursor: string | undefined;

  do {
    const data = await apsGraphQL<{
      elementsByElementGroup: {
        pagination: { cursor?: string | null };
        results: Array<{
          id: string;
          name: string;
          properties: { results: Array<{ name: string; value: unknown }> };
          geometry: {
            boundingBox: {
              min: { x: number; y: number; z: number };
              max: { x: number; y: number; z: number };
            } | null;
          } | null;
        }>;
      };
    }>(auth, LIST_ELEMENTS_WITH_BBOX_QUERY, {
      elementGroupId,
      filter,
      limit: pageLimit,
      cursor: cursor ?? null,
    });

    const page = data.elementsByElementGroup;
    for (const el of page.results ?? []) {
      const bb = el.geometry?.boundingBox ?? null;
      const bbox: BoundingBox | null = bb
        ? { min: { ...bb.min }, max: { ...bb.max } }
        : null;
      all.push({
        id: el.id,
        name: el.name,
        bbox,
        properties: (el.properties.results ?? []).map((p) => ({
          name: p.name,
          value: p.value as string | number | boolean | null,
        })),
      });
    }
    cursor = page.pagination.cursor ?? undefined;
  } while (cursor && all.length < maxElements);

  if (!referenceBox) return all;

  // Apply spatial filter
  return all.filter((el) => {
    if (!el.bbox) return false;
    switch (mode) {
      case 'inside':
        return bboxInside(el.bbox, referenceBox);
      case 'contains':
        return bboxInside(referenceBox, el.bbox);
      case 'intersects':
      default:
        return bboxIntersects(el.bbox, referenceBox);
    }
  });
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
