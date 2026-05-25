import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listHubs } from '../../apis/data-management.js';

const inputSchema = z.object({});

export const listHubsTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_list_hubs',
  title: 'List Forma Hubs',
  description:
    'Lists all Autodesk Forma (ACC) hubs the service account has access to. ' +
    '"Hub" is the new name for "Account" (renamed 24 March 2026). ' +
    'Returns hub IDs, names, and regions. ' +
    'Use hub IDs with dm.list_projects, admin.list_projects, and other tools.',
  kind: 'read',
  preferredAuth: '2lo',
  scopes: ['data:read'],
  inputSchema,

  execute: async (_input, ctx) => {
    const hubs = await listHubs(ctx.auth);

    if (hubs.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No hubs found. Ensure the service account (SSA) has been invited to at least one ' +
              'Autodesk Forma hub. See docs/AUTH.md for setup steps.',
          },
        ],
        structuredContent: { hubs: [] },
      };
    }

    const lines = hubs.map(
      (h) => `• ${h.name}  (ID: ${h.id})  [region: ${h.region}]`,
    );

    return {
      content: [
        {
          type: 'text',
          text: `Found ${hubs.length} hub(s):\n\n${lines.join('\n')}`,
        },
      ],
      structuredContent: { hubs },
    };
  },
};
