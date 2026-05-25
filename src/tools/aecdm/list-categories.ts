import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listAecdmCategories } from '../../apis/aecdm.js';

const inputSchema = z.object({
  element_group_id: z
    .string()
    .min(1)
    .describe(
      'Element group ID from aecdm_list_element_groups. ' +
        'Identifies which BIM model file to scan for categories.',
    ),
});

export const aecdmListCategoriesTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_list_categories',
  title: 'List BIM Element Categories',
  description:
    'Lists BIM categories present in an element group with approximate counts. ' +
    'Probes ~60 well-known Revit categories (Architectural / Structural / MEP / Furniture) ' +
    'in parallel using the verified-working filter syntax, and returns those with elements found. ' +
    'Counts are capped at 100 per category — for exact totals, use aecdm_aggregate_by_parameter. ' +
    'Use the returned category names with aecdm_query_elements.\n\n' +
    'If empty: the model file may have been uploaded before AEC Data Model was enabled on the hub. ' +
    'Re-publish the Revit file to trigger indexing.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const categories = await listAecdmCategories(ctx.auth, input.element_group_id);

    if (categories.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No element categories found in this element group.\n\n' +
              'Possible reasons:\n' +
              '  1. The Revit file was uploaded BEFORE AEC Data Model was enabled on the hub — ' +
              're-publish the file to index it.\n' +
              '  2. The model has no BIM elements with a "category" property.\n' +
              '  3. The element group ID is incorrect — verify with aecdm_list_element_groups.',
          },
        ],
        structuredContent: { categories: [] },
      };
    }

    const lines = categories.map(
      (c) => `• ${c.name}  (${c.count}${c.count >= 100 ? '+' : ''} element(s))`,
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `${categories.length} category(ies) found:\n\n` +
            lines.join('\n') +
            '\n\nNote: counts are capped at 100 per category (probe limit). ' +
            'For exact totals + breakdown, use aecdm_aggregate_by_parameter.',
        },
      ],
      structuredContent: { categories },
    };
  },
};
