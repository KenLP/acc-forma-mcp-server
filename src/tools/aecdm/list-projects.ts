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
    'Returns project IDs and names for use with aecdm_list_element_groups. ' +
    'Requires an AECDM hub ID from aecdm_list_hubs (not the same as a DM hub ID).',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
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

    const lines = projects.map((p) => `• ${p.name}  (ID: ${p.id})`);

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${projects.length} AEC project(s):\n\n` +
            lines.join('\n') +
            '\n\nUse a project ID with aecdm_list_element_groups to see BIM models.',
        },
      ],
      structuredContent: { projects },
    };
  },
};
