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
    '**AEC Data Model (GraphQL)** — queries BIM elements by category, returning element IDs, ' +
    'names, and semantic properties (parameters).\n\n' +
    'Input: `element_group_id` from `aecdm_list_element_groups` — NOT a DM version URN.\n\n' +
    '**API boundary — do NOT confuse with Model Derivative:**\n' +
    '  • This tool uses **AECDM GraphQL** (semantic/parameter data, live BIM data).\n' +
    '  • For element bounding boxes (AABBs) or geometry extents, use `md_get_properties` instead.\n' +
    '  • For checking soft clash / clearance, use `md_get_properties` + `md_check_clearance`.\n\n' +
    'Possible categories: Walls, Windows, Floors, Doors, Furniture, Ceilings, Electrical Equipment. ' +
    'Use aecdm_list_categories to discover all available categories. ' +
    'Use aecdm_aggregate_by_parameter to count elements grouped by a property.',
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
