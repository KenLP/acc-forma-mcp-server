import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getElementProperties } from '../../apis/aecdm.js';

const inputSchema = z.object({
  element_group_id: z
    .string()
    .min(1)
    .describe(
      'Element group ID from aecdm_list_element_groups. ' +
        'Identifies which BIM model file the element belongs to.',
    ),
  element_id: z
    .string()
    .min(1)
    .describe(
      'AECDM element node ID (base64-encoded, starts with prefix like "YWVjZX5t..."). ' +
        'Obtain from aecdm_query_elements.',
    ),
  category: z
    .string()
    .min(1)
    .describe(
      'BIM element category (e.g. "Structural Columns", "Walls"). ' +
        'REQUIRED — AECDM elementsByElementGroup needs a filter; pass the same ' +
        'category that produced this element_id from aecdm_query_elements.',
    ),
});

export const getElementPropertiesTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_get_element_properties',
  title: 'Get AEC Element Properties',
  description:
    'Retrieves all properties of a specific BIM element by `element_id`, ' +
    'equivalent to the Properties panel in Revit. Requires the same `category` ' +
    'used to originally find the element, since the AECDM API requires a category ' +
    'filter on every element query.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const element = await getElementProperties(
      ctx.auth,
      input.element_group_id,
      input.element_id,
      input.category,
    );

    if (!element) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Element "${input.element_id}" not found in category "${input.category}".\n\n` +
              `Possible reasons:\n` +
              `  1. The element_id belongs to a different category — verify with aecdm_query_elements.\n` +
              `  2. The element was removed or modified in a newer model version.\n` +
              `  3. The element_group_id is incorrect.`,
          },
        ],
        structuredContent: { element: null },
      };
    }

    const propLines = element.properties.map(
      (p) => `  ${p.name}: ${p.value ?? 'N/A'}`,
    );

    const text =
      `Element: ${element.name}\n` +
      `ID: ${element.id}\n` +
      `Category: ${input.category}\n` +
      `Total properties: ${element.properties.length}\n\n` +
      `Properties:\n` +
      propLines.join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: { element },
    };
  },
};
