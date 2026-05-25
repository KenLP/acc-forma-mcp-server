import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { queryElementsByCategory } from '../../apis/aecdm.js';

const inputSchema = z.object({
  element_group_id: z
    .string()
    .min(1)
    .describe(
      'Element group ID from aecdm_list_element_groups. ' +
        'Identifies which BIM model file to aggregate elements from.',
    ),
  category: z
    .string()
    .min(1)
    .describe(
      'BIM element category to aggregate within (e.g., "Walls", "Doors", "Floors"). ' +
        'Use aecdm_list_categories to see available categories.',
    ),
  group_by_property: z
    .string()
    .min(1)
    .describe(
      'Property name to group elements by (e.g., "Type Name", "Level", "Material"). ' +
        'Elements with the same value for this property are counted together.',
    ),
});

export const aecdmAggregateByParameterTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_aggregate_by_parameter',
  title: 'Aggregate BIM Elements by Parameter',
  description:
    'Counts BIM elements grouped by a parameter value within a category. ' +
    'Example: category="Walls", group_by_property="Type Name" → shows how many walls of each type. ' +
    'Useful for material take-offs, element counts by level, and design analysis.',
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
        structuredContent: { aggregations: [], totalSampled: 0 },
      };
    }

    // Group client-side by the requested property
    const counts = new Map<string, number>();
    for (const el of elements) {
      const prop = el.properties.find(
        (p) => p.name.toLowerCase() === input.group_by_property.toLowerCase(),
      );
      const key =
        prop !== undefined ? String(prop.value ?? '(none)') : '(property not found)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const aggregations = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));

    const lines = aggregations.map((a) => `• ${a.value}: ${a.count}`);

    return {
      content: [
        {
          type: 'text',
          text:
            `${input.category} grouped by "${input.group_by_property}" (${elements.length} elements):\n\n` +
            lines.join('\n'),
        },
      ],
      structuredContent: {
        aggregations,
        totalSampled: elements.length,
        category: input.category,
        groupByProperty: input.group_by_property,
      },
    };
  },
};
