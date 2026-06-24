import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { queryElementsByCategory } from '../../apis/aecdm.js';
import { isAecdmUnavailableParam, aecdmToMdRedirect } from './_param-guidance.js';

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
      'Property name to group elements by (e.g., "Type Name", "Material", "Family Name"). ' +
        'Elements with the same value for this property are counted together. ' +
        '⚠️ Do NOT use this to group by storey/level — AECDM does not expose Level, ' +
        'Base Constraint, Top Constraint or Host (they are element references, not values). ' +
        'For per-level grouping or area take-off use md_get_properties with fields=[...] instead.',
    ),
});

export const aecdmAggregateByParameterTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_aggregate_by_parameter',
  title: 'Aggregate BIM Elements by Parameter',
  description:
    'Counts BIM elements grouped by a **value** parameter within a category. ' +
    'Example: category="Walls", group_by_property="Type Name" → how many walls of each type. ' +
    'Good for type/material/family take-offs.\n\n' +
    '⛔ **NOT for grouping by storey/level.** AECDM omits Revit reference parameters ' +
    '(Level, Base Constraint, Top Constraint, Host), so grouping by them returns nothing useful. ' +
    'For "elements/area per level", use `md_get_properties(category_filter=..., fields=["Level"|"Base Constraint","Area"])` ' +
    'and group/sum in your reasoning — see that tool. This tool will redirect you there if you try.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    // Short-circuit: a known reference/constraint param AECDM never exposes.
    // Redirect to Model Derivative before spending a query round-trip.
    if (isAecdmUnavailableParam(input.group_by_property)) {
      const msg = aecdmToMdRedirect(input.category, input.group_by_property);
      return {
        content: [{ type: 'text', text: msg }],
        structuredContent: {
          aggregations: [],
          totalSampled: 0,
          unavailableParameter: input.group_by_property,
          useInstead: 'md_get_properties',
        },
      };
    }

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

    // If the property doesn't exist on (almost) every element, the grouping is
    // meaningless — likely a misspelling or a parameter AECDM doesn't expose.
    // Surface a redirect to Model Derivative instead of a single useless bucket.
    const notFound = counts.get('(property not found)') ?? 0;
    const propertyMissing = notFound / elements.length > 0.8;

    const lines = aggregations.map((a) => `• ${a.value}: ${a.count}`);

    const text = propertyMissing
      ? `Property "${input.group_by_property}" was not found on ${notFound}/${elements.length} ` +
        `${input.category} elements — AECDM does not expose it.\n\n` +
        aecdmToMdRedirect(input.category, input.group_by_property)
      : `${input.category} grouped by "${input.group_by_property}" (${elements.length} elements):\n\n` +
        lines.join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        aggregations,
        totalSampled: elements.length,
        category: input.category,
        groupByProperty: input.group_by_property,
        ...(propertyMissing ? { propertyMissing: true, useInstead: 'md_get_properties' } : {}),
      },
    };
  },
};
