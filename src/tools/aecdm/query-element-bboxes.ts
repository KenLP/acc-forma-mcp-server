import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { queryElementBoundingBoxes } from '../../apis/aecdm.js';

const vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const bboxSchema = z.object({
  min: vec3Schema,
  max: vec3Schema,
});

const inputSchema = z.object({
  element_group_id: z
    .string()
    .min(1)
    .describe('Element group ID from aecdm_list_element_groups.'),
  category: z
    .string()
    .min(1)
    .describe(
      'BIM category to query (e.g. "Walls", "Structural Columns", "Doors"). ' +
        'Required because AECDM elementsByElementGroup needs a filter. ' +
        'Use aecdm_list_categories to discover available categories.',
    ),
  reference_bbox: bboxSchema
    .optional()
    .describe(
      'Optional reference bounding box for spatial filtering. ' +
        'If omitted, returns every element bbox in the category. ' +
        'Coordinates are in the model file\'s units (typically millimeters or feet, ' +
        'matching the source Revit/IFC file).',
    ),
  mode: z
    .enum(['intersects', 'inside', 'contains'])
    .default('intersects')
    .describe(
      'Spatial relationship between element bbox and reference_bbox:\n' +
        '  - "intersects" (default): element overlaps the reference (clash detection)\n' +
        '  - "inside": element bbox is fully inside reference (containment / "what is in this room")\n' +
        '  - "contains": element bbox fully contains the reference (which large element envelops a point)',
    ),
  max_elements: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(500)
    .describe('Maximum elements to fetch before client-side spatial filtering.'),
});

export const aecdmQueryElementBBoxesTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_query_element_bboxes',
  title: 'Query BIM Element Bounding Boxes',
  description:
    'Returns BIM elements with their axis-aligned bounding boxes (min/max XYZ in model coordinates). ' +
    'Use for clash detection, containment checks, room-occupancy queries, and spatial reasoning.\n\n' +
    'Three modes via `reference_bbox` + `mode`:\n' +
    '  • Without reference_bbox — list every element bbox in the category.\n' +
    '  • With reference_bbox + mode="intersects" — clash detection (returns elements overlapping the reference).\n' +
    '  • With reference_bbox + mode="inside" — find elements wholly inside a region (e.g. "what columns are in this floor slab\'s footprint").\n' +
    '  • With reference_bbox + mode="contains" — find large elements that envelop the reference point/region.\n\n' +
    'NOTE: AECDM `geometry` is a beta GraphQL field. If the field is unavailable for a given hub or ' +
    'element group, the tool will return an error from the GraphQL layer. Elements without geometry ' +
    'are excluded from spatial-filter results.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const elements = await queryElementBoundingBoxes(
      ctx.auth,
      input.element_group_id,
      input.category,
      {
        maxElements: input.max_elements,
        ...(input.reference_bbox ? { referenceBox: input.reference_bbox } : {}),
        mode: input.mode,
      },
    );

    if (elements.length === 0) {
      const reason = input.reference_bbox
        ? `No elements in "${input.category}" match mode="${input.mode}" against the reference bbox.`
        : `No elements found in "${input.category}". The category may not exist in this element group, or the model has no geometry indexed.`;
      return {
        content: [{ type: 'text', text: reason }],
        structuredContent: { elements: [], category: input.category },
      };
    }

    const lines = elements.slice(0, 50).map((el) => {
      if (!el.bbox) return `• ${el.name}  (ID: ${el.id})  [no geometry]`;
      const { min, max } = el.bbox;
      const fmt = (v: number): string => v.toFixed(3);
      return (
        `• ${el.name}  (ID: ${el.id})\n` +
        `  bbox: min(${fmt(min.x)}, ${fmt(min.y)}, ${fmt(min.z)}) → max(${fmt(max.x)}, ${fmt(max.y)}, ${fmt(max.z)})`
      );
    });

    const truncated = elements.length > 50 ? `\n\n…and ${elements.length - 50} more` : '';
    const header = input.reference_bbox
      ? `${elements.length} element(s) in "${input.category}" matching mode="${input.mode}":`
      : `${elements.length} element(s) in "${input.category}" with bounding boxes:`;

    return {
      content: [
        {
          type: 'text',
          text: `${header}\n\n${lines.join('\n\n')}${truncated}`,
        },
      ],
      structuredContent: {
        elements,
        category: input.category,
        mode: input.mode,
        ...(input.reference_bbox ? { referenceBox: input.reference_bbox } : {}),
      },
    };
  },
};
