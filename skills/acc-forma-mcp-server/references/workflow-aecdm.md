# AEC Data Model — workflow, filter DSL, gotchas

The AECDM domain queries the BIM GraphQL API at `https://developer.api.autodesk.com/aec/graphql`. It indexes Revit and IFC models published to ACC/Forma. This file documents the call ordering and the non-obvious behaviours that have caused real-world failures.

## Canonical workflow

```
aecdm_list_hubs                → AECDM hub_id
   ↓
aecdm_list_projects(hub_id)    → AECDM project_id
   ↓
aecdm_list_element_groups      → element_group_id (one per Revit/IFC file)
   ↓
aecdm_list_categories          → list of categories present in the model
   ↓
aecdm_query_elements(category) → elements + their properties
   ↓ (optional, if you saved an element_id)
aecdm_get_element_properties(element_id, category)
```

Three tools never used standalone: `aecdm_query_elements`, `aecdm_get_element_properties`, and `aecdm_aggregate_by_parameter` all need an `element_group_id` from `aecdm_list_element_groups`.

## AECDM hub IDs ≠ DM hub IDs

This is the #1 source of confusion. The Data Management API and the AEC Data Model API have **separate hub ID namespaces**.

- `dm_list_hubs` returns DM hub IDs (used by `dm_*` and `admin_*` tools).
- `aecdm_list_hubs` returns AECDM hub IDs (used by `aecdm_*` tools).

Passing a DM hub ID to `aecdm_list_projects` will fail or return empty. Always start AECDM workflows with `aecdm_list_hubs`.

## Filter DSL syntax

The filter DSL is RSQL-like. The query string lives in:

```graphql
elementsByElementGroup(
  elementGroupId: $id
  filter: { query: $filterString }
)
```

**Required form** (verified working for both single-word and multi-word values):

```
property.name.category=='Walls'
property.name.category=='Structural Columns'
property.name.category=='Electrical Equipment'
```

Single quotes around the value are **required** even for single-word categories. Forms that look reasonable but fail:

| Filter | Result |
|---|---|
| `property.name.category==Walls` | Works in some versions, fails silently in others |
| `property.name.category==Structural Columns` | Always fails (DSL parse error) |
| `property.name.category=="Structural Columns"` | Fails |
| `'property.name.category'=='Structural Columns'` | Quoting the property name (left side) is wrong |
| Empty filter `""` | API requires a non-empty filter; returns nothing or 400 |

For property names that contain spaces (the LEFT side, not the value), use single quotes there too:

```
'property.name.Element Context'=='Instance'
```

## `elementsByElementGroup` requires a filter

There is no "list all elements" endpoint. The API requires a non-empty filter argument every time. This is why `aecdm_list_categories` cannot just fetch everything and derive categories client-side — it would have nothing to derive from.

Workarounds the server uses internally:

- `aecdm_list_categories` probes ~60 well-known Revit categories in parallel and returns those with hits.
- `aecdm_query_elements` always filters by the category the caller passes.
- `aecdm_get_element_properties` requires `category` so it can issue a real filter.

If a user asks for "all elements in the model", redirect them to either:
1. List categories first, then query each category, OR
2. Pick a specific category they care about.

## Common Revit categories (probed by `list_categories`)

The server probes these in parallel. If your model has any of these with non-zero counts, they will appear in the result:

**Architectural:** Walls, Floors, Ceilings, Roofs, Doors, Windows, Stairs, Railings, Ramps, Curtain Panels, Curtain Wall Mullions, Curtain Systems, Curtain Wall Grids
**Structural:** Structural Columns, Structural Framing, Structural Foundations, Structural Connections, Structural Trusses, Structural Rebar, Structural Stiffeners, Structural Beam Systems
**MEP:** Pipes, Pipe Fittings, Ducts, Duct Fittings, Air Terminals, Conduits, Cable Trays, Mechanical Equipment, Electrical Equipment, Lighting Fixtures, Plumbing Fixtures, Sprinklers, Communication / Data / Fire Alarm / Security Devices
**Furniture / Equipment:** Furniture, Casework, Specialty Equipment, Generic Models, Mass, Site, Planting, Topography
**Annotation:** Levels, Grids, Reference Planes, Rooms, Spaces, Areas, Project Information

If the user has a custom category not in this list, they can still pass it directly to `aecdm_query_elements` — the probe list is only for discovery via `list_categories`.

## GraphQL node IDs are NOT properties

Element IDs returned by `aecdm_query_elements` are base64-encoded GraphQL node IDs (e.g. `YWVjZX5t...`). The filter DSL operates on element **properties**, not on the node ID. So this fails silently:

```
property.name.id=='YWVjZX5t...'   ❌ never matches
```

That's why `aecdm_get_element_properties` requires a `category` parameter — the server queries the category, then matches the node ID client-side. Pass the same category that produced the element ID via `aecdm_query_elements`.

In most cases users don't need `aecdm_get_element_properties` at all: `aecdm_query_elements` already returns full properties for every element it lists.

## Indexing prerequisite — re-publish is often the fix

> "Only design files uploaded AFTER the hub had AEC Data Model enabled are indexed."

If a model was uploaded before the hub had AECDM enabled, the file is invisible to all `aecdm_*` tools — `list_element_groups` may show it, but `query_elements` returns empty. The fix is on the user side, not in code:

1. Open the Revit file.
2. Re-publish it to ACC/Forma (creates a new version).
3. Re-run `aecdm_list_element_groups` and use the newest element_group_id.

When `aecdm_list_categories` returns empty for a model that obviously has BIM elements, this is the most likely cause. Tell the user to re-publish before assuming the server is broken.

## Schema notes — `distinctPropertyValuesInElementGroupByName`

Autodesk's blog suggests this query for category discovery, but the actual API schema does not match the documented shape (`results { value count }` is rejected; the inner type's real fields are unclear). The server avoids this query and uses parallel category probes instead — slower but deterministic.

If a future API version stabilises this query, switch `aecdm_list_categories` to use it. Until then, do not rely on it.

## Pagination

`elementsByElementGroup` supports cursor-based pagination via `pagination: { limit, cursor }`. The server auto-paginates up to 500 elements by default for `query_elements` and 1000 for `get_element_properties`. If a category has more than 500 elements, increase `maxElements` or query a more specific filter.

## Geometry / element positions (beta field)

The AECDM schema exposes a `geometry { pieces { transform } }` selection on each element node via `geometryDataByElements`. This is currently a **Public Beta** feature — it works on most hubs but may return null or fail on some.

The server uses this field in `aecdm_query_element_positions`, which returns the **origin point** (x, y, z) decoded from each element's first geometry piece transform. This is the primary use case for populating ACC Issue pushpins (`linked_documents[].details.position`).

An optional `reference_bbox` parameter filters results to elements whose origin point lies inside the box (point-in-box test), useful for room-occupancy or zone queries.

**Important limitations:**
- Returns an origin *point*, not a full axis-aligned bounding box (AABB). For true bbox/clash detection, use the Model Derivative API instead.
- Elements without geometry data return `position: null`.
- Coordinates are in the source model's units (typically millimetres for metric Revit, feet for imperial).

If the `geometry` field returns null on a hub, fall back to property-based queries.

## Region

The server forwards the `region` HTTP header when set. AECDM is currently available in AMER, EMEA, and AUS regions. If the hub is in a region not yet supported, queries may return 404 even when other ACC tools work fine.
