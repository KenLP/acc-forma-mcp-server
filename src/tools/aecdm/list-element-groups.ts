import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listAecdmElementGroups } from '../../apis/aecdm.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('AECDM project ID from aecdm_list_projects.'),
});

export const aecdmListElementGroupsTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_list_element_groups',
  title: 'List AEC Element Groups (BIM Models)',
  description:
    'Lists element groups (BIM model files) in an AEC Data Model project. ' +
    'Each element group corresponds to a published Revit or IFC model. ' +
    'Returns element group IDs (for use with aecdm_query_elements) and file version URNs. ' +
    'Element group IDs are required for all element-level queries.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  // NOTE: the project_id input holds an AECDM project id, NOT a DM `b.<guid>` — the two
  // are different id spaces (aecdm_list_projects returns both side by side). The old
  // name-based allow-list check matched this field and compared an AECDM id against DM
  // ids, which protected nothing and rejected valid calls.
  scope: { kind: 'unmappable', resource: 'AECDM-native project id' },
  inputSchema,

  execute: async (input, ctx) => {
    const elementGroups = await listAecdmElementGroups(ctx.auth, input.project_id);

    if (elementGroups.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No element groups (BIM models) found in this project. ' +
              'Ensure at least one Revit or IFC model has been published to AEC Data Model.',
          },
        ],
        structuredContent: { elementGroups: [] },
      };
    }

    const lines = elementGroups.map(
      (eg) =>
        `• ${eg.name}  (ID: ${eg.id})` +
        (eg.fileVersionUrn ? `\n  fileVersionUrn: ${eg.fileVersionUrn}` : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${elementGroups.length} element group(s):\n\n` +
            lines.join('\n\n') +
            '\n\nUse an element group ID with aecdm_query_elements to query BIM elements.',
        },
      ],
      structuredContent: { elementGroups },
    };
  },
};
