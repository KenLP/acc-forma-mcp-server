import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { adminListProjects } from '../../apis/admin.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe('Hub (Account) ID. Get from dm_list_hubs. Accepts with or without b. prefix.'),
  status: z
    .enum(['active', 'inactive', 'archived'])
    .optional()
    .describe('Filter by project status. Omit to return all.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max results per page.'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
});

export const adminListProjectsTool: ReadToolDef<typeof inputSchema> = {
  name: 'admin_list_projects',
  title: 'List Forma Projects (Admin)',
  description:
    'Lists all projects in a Forma hub using the Account Admin API. ' +
    'Returns richer metadata than dm_list_projects (status, type, dates, address). ' +
    'Requires the service account to have Account Admin role.\n\n' +
    'Use dm_list_hubs first to obtain hub_id.',
  kind: 'read',
  preferredAuth: '2lo',
  scopes: ['account:read'],
  inputSchema,

  execute: async (input, ctx) => {
    const { results, pagination } = await adminListProjects(ctx.auth, input.hub_id, {
      limit: input.limit,
      offset: input.offset,
      ...(input.status ? { status: input.status } : {}),
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No projects found for this hub.' }],
        structuredContent: { projects: [], pagination },
      };
    }

    const lines = results.map(
      (p) =>
        `• ${p.name}  (ID: ${p.id})  [status: ${p.status}${p.type ? ', type: ' + p.type : ''}]`,
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${pagination.totalResults} project(s) (showing ${results.length}):\n\n` +
            lines.join('\n'),
        },
      ],
      structuredContent: { projects: results, pagination },
    };
  },
};
