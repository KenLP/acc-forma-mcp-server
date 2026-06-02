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
        'Coordinates are in the source model\'s units (typically millimetres ' +
        'for metric Revit, feet for imperial).',
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
    'Returns BIM elements with their origin position (x, y, z in model coordinates). ' +
    'Each position is decoded from the element\'s first geometry piece transform.\n\n' +
    'Primary use case: populate ACC Issue pushpins — `linked_documents[].details.position` — ' +
    'so reviewers can click "View in Model" and jump to the element in the Forge Viewer.\n\n' +
    'Optional `reference_bbox` filters results to elements whose position lies inside the ' +
    'box (point-in-box test) — useful for room-occupancy or zone queries.\n\n' +
    'NOTE: AECDM `geometryDataByElements` is currently in **Public Beta** (Autodesk). ' +
    'This tool returns an *origin point*, not an axis-aligned bbox — AECDM does not expose ' +
    'AABBs directly. For a true bbox, use Model Derivative API. Elements without geometry ' +
    'data return `position: null`.',
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
      if (!el.position) return `• ${el.name}  (ID: ${el.id})  [no geometry data]`;
      const { x, y, z } = el.position;
      return `• ${el.name}  (ID: ${el.id})\n  position: (${fmt(x)}, ${fmt(y)}, ${fmt(z)})`;
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
