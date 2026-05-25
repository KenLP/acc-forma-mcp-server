/** Strip "b." prefix — Issues v2 / RFIs v3 / Reviews take bare UUID */
export const stripBPrefix = (id: string): string => id.replace(/^b\./, '');

/** Ensure "b." prefix — Data Management + Admin take prefixed form */
export const addBPrefix = (id: string): string =>
  id.startsWith('b.') ? id : `b.${id}`;

/** Return both forms for allow-list matching */
export const normalizeProjectId = (id: string): { withPrefix: string; bare: string } => ({
  withPrefix: addBPrefix(id),
  bare: stripBPrefix(id),
});
