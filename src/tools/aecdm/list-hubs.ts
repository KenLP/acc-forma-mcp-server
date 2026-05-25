import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listAecdmHubs } from '../../apis/aecdm.js';

const inputSchema = z.object({});

export const aecdmListHubsTool: ReadToolDef<typeof inputSchema> = {
  name: 'aecdm_list_hubs',
  title: 'List AEC Data Model Hubs',
  description:
    'Lists all AECDM (AEC Data Model) hubs accessible to this account. ' +
    'AECDM hub IDs are different from DM hub IDs — use these IDs with aecdm_list_projects. ' +
    'Call this first to discover your AECDM hub ID before querying projects or BIM elements.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (_input, ctx) => {
    const hubs = await listAecdmHubs(ctx.auth);

    if (hubs.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No AEC Data Model hubs found. ' +
              'Ensure the AEC Data Model API is enabled for your account.',
          },
        ],
        structuredContent: { hubs: [] },
      };
    }

    const lines = hubs.map((h) => `• ${h.name}  (ID: ${h.id})`);

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${hubs.length} AECDM hub(s):\n\n` +
            lines.join('\n') +
            '\n\nUse the hub ID with aecdm_list_projects to see projects in that hub.',
        },
      ],
      structuredContent: { hubs },
    };
  },
};
