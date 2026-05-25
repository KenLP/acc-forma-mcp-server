import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { adminListUsers } from '../../apis/admin.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe('Hub (Account) ID. Get from dm.list_hubs.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max results per page.'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
});

export const adminListUsersTool: ReadToolDef<typeof inputSchema> = {
  name: 'admin_list_users',
  title: 'List Forma Account Users',
  description:
    'Lists all users in a Forma hub (Account). ' +
    'Returns Autodesk user IDs, emails, names, and roles. ' +
    'User IDs returned here can be used with issues.create (assigned_to) and reviews.create (reviewerIds). ' +
    'Requires Account Admin role.',
  kind: 'read',
  preferredAuth: '2lo',
  scopes: ['account:read'],
  inputSchema,

  execute: async (input, ctx) => {
    const { results, pagination } = await adminListUsers(ctx.auth, input.hub_id, {
      limit: input.limit,
      offset: input.offset,
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No users found for this hub.' }],
        structuredContent: { users: [], pagination },
      };
    }

    const lines = results.map(
      (u) =>
        `• ${u.name}  <${u.email}>  (ID: ${u.id})` +
        (u.roleName ? `  [${u.roleName}]` : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${pagination.totalResults} user(s) (showing ${results.length}):\n\n` +
            lines.join('\n'),
        },
      ],
      structuredContent: { users: results, pagination },
    };
  },
};
