import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { adminListProjects } from '../../apis/admin.js';
import { isProjectAllowed } from '../../safety/allowlist.js';

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
    'Lists the projects in a Forma hub via the Account Admin API, with richer metadata ' +
    'than dm_list_projects: status, type, dates, and address. Takes a hub id, which ' +
    'dm_list_hubs returns. Requires the service account to hold the Account Admin role.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'dm' },
  scopes: ['account:read'],
  inputSchema,

  getHubId: (i) => i.hub_id,

  execute: async (input, ctx) => {
    const { results, pagination } = await adminListProjects(ctx.auth, input.hub_id, {
      limit: input.limit,
      offset: input.offset,
      ...(input.status ? { status: input.status } : {}),
    });

    // Account Admin API returns every project in the hub regardless of the allow-list;
    // filter the page before it reaches the caller. `pagination.totalResults` as returned
    // by APS counts the UNFILTERED set, which would leak how many projects exist outside
    // the allow-list. Report the filtered count instead so nothing about the excluded
    // projects is observable from the response.
    const projects = results.filter((p) => isProjectAllowed(p.id));
    const filteredPagination = { ...pagination, totalResults: projects.length };

    if (projects.length === 0) {
      return {
        content: [{ type: 'text', text: 'No projects found for this hub.' }],
        structuredContent: { projects: [], pagination: filteredPagination },
      };
    }

    const lines = projects.map(
      (p) =>
        `• ${p.name}  (ID: ${p.id})  [status: ${p.status}${p.type ? ', type: ' + p.type : ''}]`,
    );

    return {
      content: [
        {
          type: 'text',
          text: `Found ${projects.length} project(s):\n\n` + lines.join('\n'),
        },
      ],
      structuredContent: { projects, pagination: filteredPagination },
    };
  },
};
