import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listHubs } from '../../apis/data-management.js';
import { isHubAllowed } from '../../safety/allowlist.js';

const inputSchema = z.object({});

export const listHubsTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_list_hubs',
  title: 'List Forma Hubs',
  description:
    'Lists the Autodesk Forma (ACC) hubs the service account has access to, returning the ' +
    'hub ID, name, and region of each. "Hub" is the new name for "Account" (renamed ' +
    '24 March 2026). Hub IDs are in Data Management form (b.<guid>) and are the hub_id ' +
    'that dm_list_projects and admin_list_projects accept. When a hub allow-list is ' +
    'configured, only allow-listed hubs are returned.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'discovery' },
  scopes: ['data:read'],
  inputSchema,

  execute: async (_input, ctx) => {
    // No hub_id input to check against the allow-list up front, so filter the credential's
    // full hub list down to the allowed set here instead of returning everything it can see.
    const hubs = (await listHubs(ctx.auth)).filter((h) => isHubAllowed(h.id));

    if (hubs.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No hubs found. Ensure the service account (SSA) has been invited to at least one ' +
              'Autodesk Forma hub, and that FORMA_ALLOWED_HUBS includes it. See docs/AUTH.md for setup steps.',
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
