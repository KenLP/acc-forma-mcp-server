import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getMdProperties, aggregateMdProperties } from '../../apis/model-derivative.js';
import { checkUnscopedToolAllowed } from '../../safety/allowlist.js';

const inputSchema = z.object({
  urn: z
    .string()
    .min(1)
    .describe(
      'Item version URN from Data Management (from dm_list_versions). ' +
        'Accepts raw "urn:adsk..." or base64url-encoded form. ' +
        'NOT an AECDM elementGroupId.',
    ),
  view_guid: z
    .string()
    .optional()
    .describe(
      'GUID of the 3D view to query (from md_get_manifest). ' +
        'If omitted, the first available 3D view is used automatically.',
    ),
  category_filter: z
    .string()
    .optional()
    .describe(
      'Case-insensitive substring match on the Revit element category ' +
        '(e.g. "Walls", "Structural Columns", "Mechanical Equipment"). ' +
        'Elements that do not match are skipped. ' +
        'Omit to return all categories up to max_results.',
    ),
  object_ids: z
    .array(z.number().int())
    .optional()
    .describe(
      'Restrict to specific Revit objectIds (dbIds). ' +
        'Useful when you already know the IDs from the object tree.',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(200)
    .describe(
      'Maximum number of elements to return. ' +
        'Pagination is handled automatically up to this limit.',
    ),
  include_bbox: z
    .boolean()
    .default(true)
    .describe(
      'Include element bounding box (axis-aligned, in model internal units — ' +
        'decimal feet for US-imperial Revit, metres for metric). ' +
        'Setting false speeds up retrieval when only element names/parameters are needed.',
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Revit parameter names to return per element (case-insensitive; searched across all ' +
        'property groups). This is the key to grouping/quantity analysis — MD exposes the FULL ' +
        'Revit parameter set that AECDM omits. Examples:\n' +
        '  • Floors by level + area:  fields=["Level", "Area"]\n' +
        '  • Walls by level + area:   fields=["Base Constraint", "Area"]  (walls use "Base Constraint", not "Level")\n' +
        '  • Also useful: "Volume", "Top Constraint", "Phase Created", "Type Name", "Material".\n' +
        'Each element returns a `properties` map of the matched params; group/sum them in your reasoning. ' +
        'NOTE: per-element output is capped at max_results and only ~30 rows render in text — for a ' +
        'whole-building total use `group_by` instead (it sums server-side across EVERY element).',
    ),
  group_by: z
    .string()
    .optional()
    .describe(
      '⭐ Server-side GROUP + SUM across the ENTIRE category (no 30-row display cap, no max_results ' +
        'limit). Set this to the level/grouping parameter and the tool returns one compact row per ' +
        'group — count + summed area — covering every element in the building. This is the correct ' +
        'way to answer "total floor/wall area per level":\n' +
        '  • Floors per level:  category_filter="Floors", group_by="Level"\n' +
        '  • Walls per level:   category_filter="Walls",  group_by="Base Constraint"\n' +
        'By default it sums "Area" (see sum_fields). Pair with category_filter for a clean take-off.',
    ),
  sum_fields: z
    .array(z.string())
    .optional()
    .describe(
      'Numeric parameters to SUM within each group when group_by is set. Defaults to ["Area"]. ' +
        'E.g. ["Area", "Volume"]. Values are coerced to numbers (unit suffixes like "ft^2" are stripped).',
    ),
});

export const mdGetPropertiesTool: ReadToolDef<typeof inputSchema> = {
  name: 'md_get_properties',
  title: 'Get Model Derivative Element Properties',
  description:
    'Model Derivative API — fetches element properties from a translated (SVF2) model, ' +
    'with optional field projection (`fields`) over the full Revit parameter set ' +
    '(Level, Base Constraint, Area, Volume, Phase, materials) that the AEC Data Model ' +
    'does not expose. `group_by` aggregates every element in a category server-side ' +
    'with no row cap; `fields` is per-element and capped at max_results. Bounding boxes ' +
    'are not populated in SVF2 (an SVF1-era field); the Model Properties API covers bbox ' +
    'queries. Category filtering falls back to substring name-matching when SVF2 omits ' +
    'category fields (common for MEP).',
  kind: 'read',
  scopes: ['data:read'],
  preferredAuth: '2lo',
  inputSchema,

  execute: async (input, ctx) => {
    checkUnscopedToolAllowed('md_get_properties', 'Model Derivative URN');
    const auth = ctx.auth2lo ?? ctx.auth;

    // ── Server-side group + sum (whole-category take-off, no display cap) ──────
    if (input.group_by !== undefined) {
      const aggOpts: import('../../apis/model-derivative.js').AggregateMdOptions = {
        groupBy: input.group_by,
      };
      if (input.view_guid !== undefined) aggOpts.viewGuid = input.view_guid;
      if (input.category_filter !== undefined) aggOpts.categoryFilter = input.category_filter;
      if (input.sum_fields !== undefined) aggOpts.sumFields = input.sum_fields;
      const agg = await aggregateMdProperties(auth, input.urn, aggOpts);

      if (agg.totalCount === 0) {
        const msg = input.category_filter
          ? `No elements found matching category "${input.category_filter}". ` +
            'Verify the category name and that the model has a successful SVF2 translation.'
          : 'No elements found. The model may not have a successful SVF2 translation — run md_get_manifest to check.';
        return {
          content: [{ type: 'text', text: msg }],
          structuredContent: { groups: [], totalCount: 0 },
        };
      }

      const num = (n: number): string =>
        n.toLocaleString('en-US', { maximumFractionDigits: 2 });
      const sumStr = (sums: Record<string, number>): string =>
        agg.sumFields
          .map((f) => {
            const v = sums[f];
            return `Σ${f} ${v !== undefined ? num(v) : '—'}`;
          })
          .join(', ');

      const catLabel = input.category_filter ?? 'elements';
      const rows = agg.groups.map(
        (g) => `• ${g.group}: ${g.count} ${catLabel}, ${sumStr(g.sums)}`,
      );
      const totals = `Total: ${agg.totalCount} ${catLabel}, ${sumStr(agg.grandTotals)}`;
      const note =
        `\n\n(Summed server-side across all ${agg.scanned} scanned elements — ` +
        `values in model units, ft² for US-imperial Revit.` +
        (agg.truncated ? ' ⚠️ scan hit the safety cap; totals may be partial.' : '') +
        ')';

      return {
        content: [
          {
            type: 'text',
            text:
              `${catLabel} grouped by "${agg.groupByField}" — ${agg.groups.length} group(s):\n\n` +
              rows.join('\n') +
              `\n\n${totals}${note}`,
          },
        ],
        structuredContent: {
          groups: agg.groups,
          totalCount: agg.totalCount,
          grandTotals: agg.grandTotals,
          groupByField: agg.groupByField,
          sumFields: agg.sumFields,
          scanned: agg.scanned,
          truncated: agg.truncated,
        },
      };
    }

    const propertiesOpts: import('../../apis/model-derivative.js').GetMdPropertiesOptions = {
      maxResults: input.max_results,
    };
    if (input.view_guid !== undefined) propertiesOpts.viewGuid = input.view_guid;
    if (input.category_filter !== undefined) propertiesOpts.categoryFilter = input.category_filter;
    if (input.object_ids !== undefined) propertiesOpts.objectIds = input.object_ids;
    if (input.fields !== undefined) propertiesOpts.fields = input.fields;
    const elements = await getMdProperties(auth, input.urn, propertiesOpts);

    if (elements.length === 0) {
      const msg = input.category_filter
        ? `No elements found matching category "${input.category_filter}". ` +
          'Verify the category name (e.g. "Walls", "Structural Columns") and that the model has a successful SVF2 translation.'
        : 'No elements found. The model may not have a successful SVF2 translation — run md_get_manifest to check.';
      return {
        content: [{ type: 'text', text: msg }],
        structuredContent: { elements: [], count: 0 },
      };
    }

    const withBbox = elements.filter((e) => e.bbox !== undefined).length;
    const fmt = (n: number): string => n.toFixed(3);

    const propStr = (el: typeof elements[number]): string =>
      el.properties && Object.keys(el.properties).length > 0
        ? `\n  ${Object.entries(el.properties).map(([k, v]) => `${k}: ${String(v)}`).join('  |  ')}`
        : '';

    const lines = elements.slice(0, 30).map((el) => {
      const catStr = el.category ? `  [${el.category}]` : '';
      if (!el.bbox || !input.include_bbox) {
        return `• ${el.name}  (objectId: ${el.objectId})${catStr}${propStr(el)}`;
      }
      const { min, max } = el.bbox;
      const size = {
        x: max.x - min.x,
        y: max.y - min.y,
        z: max.z - min.z,
      };
      return (
        `• ${el.name}  (objectId: ${el.objectId})${catStr}${propStr(el)}\n` +
        `  bbox: min(${fmt(min.x)}, ${fmt(min.y)}, ${fmt(min.z)})  ` +
        `max(${fmt(max.x)}, ${fmt(max.y)}, ${fmt(max.z)})  ` +
        `size(${fmt(size.x)}, ${fmt(size.y)}, ${fmt(size.z)})`
      );
    });

    const truncNote = elements.length > 30 ? `\n\n…and ${elements.length - 30} more (increase max_results to fetch all)` : '';

    const header =
      `${elements.length} element(s) retrieved` +
      (input.category_filter ? ` (category filter: "${input.category_filter}")` : '') +
      (input.include_bbox ? ` — ${withBbox} with bbox, ${elements.length - withBbox} without` : '') +
      ':';

    return {
      content: [{ type: 'text', text: `${header}\n\n${lines.join('\n\n')}${truncNote}` }],
      structuredContent: {
        elements: input.include_bbox ? elements : elements.map(({ bbox: _b, ...rest }) => rest),
        count: elements.length,
        withBbox,
        viewGuid: input.view_guid ?? '(auto-selected)',
      },
    };
  },
};
