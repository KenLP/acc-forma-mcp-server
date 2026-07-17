import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { queryElementPositions } from '../../apis/aecdm.js';

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
      'BIM category to query (e.g. "Walls", "Structural Columns", "Doors", "Rooms"). ' +
        'Required because AECDM elementsByElementGroup needs a filter. ' +
        'Use aecdm_list_categories to discover available categories.',
    ),
  reference_bbox: bboxSchema
    .optional()
    .describe(
      'Optional reference bounding box. When supplied, only elements whose ' +
        'position lies inside the box are returned (point-in-box filter). ' +
        'Coordinates must be in **metres** (AECDM native unit), same as the returned positions.',
    ),
  max_elements: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(500)
    .describe('Maximum elements to fetch from the category before resolving positions.'),
  batch_size: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe(
      'How many element IDs to send per geometryDataByElements call. ' +
        'Tune lower if the API rejects large batches; higher for fewer round-trips.',
    ),
});

export const aecdmQueryElementPositionsTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_query_element_positions',
  title: 'Query BIM Element Positions',
  description:
    'Returns BIM elements with origin position (x, y, z) in metres, decoded from the ' +
    'element\'s first geometry piece transform, plus each element\'s `external_id` ' +
    '(Revit UniqueId). Positions are in AECDM/global coordinates, not ACC viewer ' +
    'coordinates — a per-model globalOffset and a unit conversion (×3.280839895 for ' +
    'imperial) apply before use as a pushpin position. Optional `reference_bbox` ' +
    '(metres) filters to elements inside the box. `geometryDataByElements` is Public ' +
    'Beta; only point-placed elements (fittings, fixtures, columns, doors) return ' +
    'geometry — linear (pipes, ducts) and planar (walls, floors) elements return ' +
    '`position: null`.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const elements = await queryElementPositions(
      ctx.auth,
      input.element_group_id,
      input.category,
      {
        maxElements: input.max_elements,
        ...(input.reference_bbox ? { referenceBox: input.reference_bbox } : {}),
        batchSize: input.batch_size,
      },
    );

    if (elements.length === 0) {
      const reason = input.reference_bbox
        ? `No elements in "${input.category}" have a position inside the reference bbox.`
        : `No elements found in "${input.category}". The category may not exist in this element group.`;
      return {
        content: [{ type: 'text', text: reason }],
        structuredContent: {
          elements: [],
          category: input.category,
          count_with_position: 0,
          count_without_position: 0,
        },
      };
    }

    const withPosition = elements.filter((el) => el.position !== null).length;
    const withoutPosition = elements.length - withPosition;

    const fmt = (v: number): string => v.toFixed(3);
    const lines = elements.slice(0, 50).map((el) => {
      const ext = el.externalId ? `  externalId: ${el.externalId}` : '';
      if (!el.position) return `• ${el.name}  (ID: ${el.id})${ext}  [no geometry data]`;
      const { x, y, z } = el.position;
      return `• ${el.name}  (ID: ${el.id})${ext}\n  position (m): (${fmt(x)}, ${fmt(y)}, ${fmt(z)})`;
    });

    const truncated = elements.length > 50 ? `\n\n…and ${elements.length - 50} more` : '';
    const header = input.reference_bbox
      ? `${elements.length} element(s) in "${input.category}" with position inside reference bbox ` +
        `(${withPosition} with position, ${withoutPosition} without):`
      : `${elements.length} element(s) in "${input.category}" ` +
        `(${withPosition} with position, ${withoutPosition} without):`;

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
        count_with_position: withPosition,
        count_without_position: withoutPosition,
        ...(input.reference_bbox ? { referenceBox: input.reference_bbox } : {}),
      },
    };
  },
};
