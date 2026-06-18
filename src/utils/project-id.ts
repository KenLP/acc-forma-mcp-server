/**
 * Strip "b." prefix (or extract GUID from workspace URN) — Issues v2 / RFIs v3 / Reviews
 * take a bare project GUID. Handles three input formats:
 *  - `b.{guid}`                                       → `{guid}`
 *  - `{guid}`                                         → `{guid}` (pass-through)
 *  - `urn:adsk.workspace:env.project:{guid}`          → `{guid}`
 */
export const stripBPrefix = (id: string): string => {
  if (id.startsWith('urn:')) {
    const lastColon = id.lastIndexOf(':');
    return lastColon >= 0 ? id.slice(lastColon + 1) : id;
  }
  return id.replace(/^b\./, '');
};

/** Ensure "b." prefix — Data Management + Admin take prefixed form */
export const addBPrefix = (id: string): string =>
  id.startsWith('b.') ? id : `b.${id}`;

/** Return both forms for allow-list matching */
export const normalizeProjectId = (id: string): { withPrefix: string; bare: string } => ({
  withPrefix: addBPrefix(id),
  bare: stripBPrefix(id),
});
