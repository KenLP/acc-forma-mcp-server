import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listAecdmProjects } from '../../apis/aecdm.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe(
      'AECDM hub ID from aecdm_list_hubs. ' +
        'Note: this is an AECDM-native hub ID, NOT a DM hub ID from dm_list_hubs.',
    ),
});

export const aecdmListProjectsTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_list_projects',
  title: 'List AEC Data Model Projects',
  description:
    'Lists projects available in the AEC Data Model (BIM GraphQL API). ' +
    'Returns the AECDM project id (for element queries) AND the Data Management project id ' +
    '(dataManagementProjectId, b.<guid>) for use with Issues/Reviews APIs — both ids in one call. ' +
    'Requires an AECDM hub ID from aecdm_list_hubs (not the same as a DM hub ID).',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  // The hub_id input is an AECDM-native hub id, which cannot be checked against the
  // DM-format FORMA_ALLOWED_HUBS. The results do carry dataManagementProjectId, but
  // filtering the output would not undo having listed a hub outside the allow-list.
  scope: { kind: 'unmappable', resource: 'AECDM-native hub id' },
  inputSchema,

  execute: async (input, ctx) => {
    const projects = await listAecdmProjects(ctx.auth, input.hub_id);

    if (projects.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No AEC Data Model projects found in this hub. ' +
              'Ensure the hub ID is correct (use aecdm_list_hubs to get valid hub IDs).',
          },
        ],
        structuredContent: { projects: [] },
      };
    }

    const lines = projects.map((p) => {
      const dmLine = p.dataManagementProjectId
        ? `\n    DM/Issues id: ${p.dataManagementProjectId}`
        : '';
      return `• ${p.name}\n    AECDM id: ${p.id}${dmLine}`;
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${projects.length} AEC project(s):\n\n` +
            lines.join('\n') +
            '\n\nUse the AECDM id with aecdm_list_element_groups. ' +
            'Use the DM/Issues id (dataManagementProjectId) with issues_*, reviews_*, and dm_* tools.',
        },
      ],
      structuredContent: { projects },
    };
  },
};
