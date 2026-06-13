import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getMdProperties } from '../../apis/model-derivative.js';

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
        'Required for md_check_clearance. Setting false speeds up retrieval.',
    ),
});

export const mdGetPropertiesTool: ReadToolDef<typeof inputSchema> = {
  name: 'md_get_properties',
  title: 'Get Model Derivative Element Properties',
  description:
    '**Model Derivative API** — fetches element properties for a translated model, ' +
    'including axis-aligned bounding boxes (AABBs) from the SVF2 derivative.\n\n' +
    'Primary use cases:\n' +
    '  • Get bounding boxes for `md_check_clearance` (soft clash / clearance check)\n' +
    '  • Inspect Revit element properties (dimensions, materials, IFC data)\n' +
    '  • Map Revit objectIds to names and categories\n\n' +
    'The model must have a successful SVF2 translation — check with `md_get_manifest` first.\n\n' +
    '**API boundary — do NOT confuse with AECDM:**\n' +
    '  • This tool uses **Model Derivative API** (file-based, URN input, geometry data).\n' +
    '  • For BIM parameter queries, category enumeration, or element counts by parameter, ' +
    'use `aecdm_*` tools (they take `element_group_id`, not URN).\n' +
    '  • AECDM returns element *origin points*; this tool returns full AABBs.\n\n' +
    '⚠️ Bounding boxes are in the model\'s own coordinate system. When comparing host vs ' +
    'linked file elements, both models must use Revit Shared Coordinates for distances to be meaningful.',
  kind: 'read',
  scopes: ['data:read'],
  preferredAuth: '2lo',
  inputSchema,

  execute: async (input, ctx) => {
    const auth = ctx.auth2lo ?? ctx.auth;
    const propertiesOpts: import('../../apis/model-derivative.js').GetMdPropertiesOptions = {
      maxResults: input.max_results,
    };
    if (input.view_guid !== undefined) propertiesOpts.viewGuid = input.view_guid;
    if (input.category_filter !== undefined) propertiesOpts.categoryFilter = input.category_filter;
    if (input.object_ids !== undefined) propertiesOpts.objectIds = input.object_ids;
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

    const lines = elements.slice(0, 30).map((el) => {
      const catStr = el.category ? `  [${el.category}]` : '';
      if (!el.bbox || !input.include_bbox) {
        return `• ${el.name}  (objectId: ${el.objectId})${catStr}`;
      }
      const { min, max } = el.bbox;
      const size = {
        x: max.x - min.x,
        y: max.y - min.y,
        z: max.z - min.z,
      };
      return (
        `• ${el.name}  (objectId: ${el.objectId})${catStr}\n` +
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
