import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listProjects } from '../../apis/data-management.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe('Hub ID from dm.list_hubs. Accepts with or without b. prefix.'),
});

export const listProjectsTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_list_projects',
  title: 'List Projects in Hub',
  description:
    'Lists all projects in a Forma hub via the Data Management API. ' +
    'Returns project IDs and names. For richer metadata (status, type, address) use admin.list_projects instead. ' +
    'Project IDs from this tool can be used with dm.list_top_folders, issues.*, reviews.*, and aecdm.* tools.',
  kind: 'read',
  preferredAuth: '2lo',
  scopes: ['data:read'],
  inputSchema,

  execute: async (input, ctx) => {
    const projects = await listProjects(ctx.auth, input.hub_id);

    if (projects.length === 0) {
      return {
        content: [{ type: 'text', text: 'No projects found in this hub.' }],
        structuredContent: { projects: [] },
      };
    }

    const lines = projects.map(
      (p) => `• ${p.name}  (ID: ${p.id})${p.status ? `  [${p.status}]` : ''}`,
    );

    return {
      content: [
        {
          type: 'text',
          text: `Found ${projects.length} project(s):\n\n${lines.join('\n')}`,
        },
      ],
      structuredContent: { projects },
    };
  },
};
