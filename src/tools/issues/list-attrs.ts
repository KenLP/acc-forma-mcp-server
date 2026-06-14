import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listIssueAttrs } from '../../apis/issues.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      'ACC project ID (with or without b. prefix). ' +
        'Get from dm_list_projects or admin_list_projects.',
    ),
});

export const listIssueAttrsTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_list_attrs',
  title: 'List Issue Custom Attribute Definitions',
  description:
    'Returns the custom attribute (field) definitions configured for the ACC Issues module ' +
    'in a project.\n\n' +
    'Use this tool to:\n' +
    '  • Discover which custom fields exist (e.g. "Contractor", "Risk Level", "Zone")\n' +
    '  • Get the `attributeDefinitionId` UUID required by `issues_create` and `issues_update` ' +
    "when populating `customAttributes`\n" +
    '  • Understand the data type and allowed values for each field\n\n' +
    'Auth: SSA or 3LO required (2LO not supported for Issues API).',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const attrs = await listIssueAttrs(ctx.auth, input.project_id);

    if (attrs.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No custom attribute definitions found for this project. ' +
              'Custom attributes are configured in ACC Admin → Issues → Custom Attributes.',
          },
        ],
        structuredContent: { attributes: [] },
      };
    }

    const lines = attrs.map((a) => {
      const listValues = a.metadata?.list;
      const valuesStr = listValues && listValues.length > 0
        ? `\n    Values: ${listValues.map((v) => `"${v.value}" (${v.id})`).join(', ')}`
        : '';
      return `• ${a.title}  [${a.type}${a.dataType ? `/${a.dataType}` : ''}]\n  ID: ${a.id}${a.description ? `\n  Desc: ${a.description}` : ''}${valuesStr}`;
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `${attrs.length} custom attribute definition(s):\n\n` +
            lines.join('\n\n'),
        },
      ],
      structuredContent: { attributes: attrs },
    };
  },
};
