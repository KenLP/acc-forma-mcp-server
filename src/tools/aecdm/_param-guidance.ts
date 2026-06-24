// Guidance for the AECDM↔Model Derivative parameter boundary.
//
// AECDM's flattened property set exposes only *value* parameters (numbers, text,
// booleans). It OMITS Revit *reference* parameters — the ones that link an element
// to another element, e.g. a Wall's Base Constraint → a Level node, or a Floor's
// Level. Grouping/filtering by those in AECDM silently yields "(property not found)"
// for every element, which sends callers off guessing alternate names ("Level Name",
// "Base Level", "Host", …) that also don't exist.
//
// The fix is to redirect to `md_get_properties`, which reads the FULL Revit parameter
// set (SVF2) and DOES resolve these references to their level/storey names.

/** Lower-cased reference/constraint parameter names AECDM does not expose. */
const AECDM_UNAVAILABLE_PARAMS = new Set([
  'level',
  'level name',
  'base level',
  'reference level',
  'schedule level',
  'base constraint',
  'top constraint',
  'host',
  'work plane',
  'reference',
]);

/** True if `param` is a Revit reference parameter AECDM cannot surface. */
export function isAecdmUnavailableParam(param: string): boolean {
  return AECDM_UNAVAILABLE_PARAMS.has(param.trim().toLowerCase());
}

/** The Model Derivative field that carries the level/storey for a given category. */
export function mdLevelFieldFor(category: string): string {
  const c = category.toLowerCase();
  // Walls anchor by Base Constraint; most other hosted elements use Level.
  if (c.includes('wall')) return 'Base Constraint';
  return 'Level';
}

/**
 * Build the redirect message shown when a caller tries to group/filter AECDM
 * elements by a parameter AECDM does not expose (level, constraints, host).
 * Points to the exact `md_get_properties` call that works.
 */
export function aecdmToMdRedirect(category: string, requested: string): string {
  const mdField = mdLevelFieldFor(category);
  return (
    `⚠️ AECDM does not expose "${requested}" for ${category}. ` +
    `Revit reference/constraint parameters — Level, Base Constraint, Top Constraint, Host — ` +
    `are links to other elements, not stored values, so AECDM drops them ` +
    `(every element falls into "(property not found)"). This is a data-source limit, ` +
    `not a missing model parameter.\n\n` +
    `➡️ Use **Model Derivative** instead — it reads the full Revit parameter set and ` +
    `resolves the level name:\n` +
    `   md_get_properties(urn=<DM version URN>, category_filter="${category}", ` +
    `fields=["${mdField}", "Area"])\n` +
    `then group by "${mdField}" and sum "Area" in your reasoning (one call per category).\n\n` +
    `Get <DM version URN> from dm_list_versions (it is the fileVersionUrn shown by ` +
    `aecdm_list_element_groups — pass that same URN to md_get_properties).`
  );
}
