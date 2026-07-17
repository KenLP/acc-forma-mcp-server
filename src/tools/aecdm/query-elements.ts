import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { queryElementsByCategory } from '../../apis/aecdm.js';

const inputSchema = z.object({
  element_group_id: z
    .string()
    .min(1)
    .describe(
      'Element group ID from aecdm_list_element_groups. ' +
        'Identifies which BIM model file to query elements from.',
    ),
  category: z
    .string()
    .min(1)
    .describe(
      'BIM element category to filter by (e.g., "Walls", "Doors", "Floors", "Windows", ' +
        '"Furniture", "Ceilings", "Electrical Equipment"). ' +
        'Use aecdm_list_categories to see available categories in the element group.',
    ),
});

export const aecdmQueryElementsTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_query_elements',
  title: 'Query BIM Elements by Category',
  description:
    'AEC Data Model GraphQL query — returns BIM elements by category with IDs, names, ' +
    'and semantic properties (parameters). Takes an `element_group_id` (not a DM ' +
    'version URN). Does not expose bounding boxes, geometry extents, or the Level, ' +
    'Base Constraint, Top Constraint, and Host reference parameters — only offset ' +
    'scalars such as Base Offset and Elevation at Bottom are returned, so elements ' +
    'cannot be grouped by storey from this data. Example categories: Walls, Windows, ' +
    'Floors, Doors, Furniture, Ceilings, Electrical Equipment.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const elements = await queryElementsByCategory(ctx.auth, input.element_group_id, input.category);

    if (elements.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No elements found in category "${input.category}". ` +
              `Use aecdm_list_categories to see available categories for this element group.`,
          },
        ],
        structuredContent: { elements: [], category: input.category },
      };
    }

    const lines = elements.map((el) => {
      const propSummary = el.properties
        .slice(0, 5)
        .map((p) => `${p.name}: ${String(p.value ?? '')}`)
        .join(', ');
      return (
        `• ${el.name}  (ID: ${el.id})` +
        (el.properties.length > 0
          ? `\n  [${propSummary}${el.properties.length > 5 ? ` … +${el.properties.length - 5} more` : ''}]`
          : '')
      );
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${elements.length} element(s) in category "${input.category}":\n\n` +
            lines.join('\n\n'),
        },
      ],
      structuredContent: { elements, category: input.category },
    };
  },
};
