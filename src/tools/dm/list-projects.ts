import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listProjects } from '../../apis/data-management.js';
import { isProjectAllowed } from '../../safety/allowlist.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe('Hub ID from dm_list_hubs. Accepts with or without b. prefix.'),
});

export const listProjectsTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_list_projects',
  title: 'List Projects in Hub',
  description:
    'Lists all projects in a Forma hub via the Data Management API. Returns ' +
    'project IDs and names; richer metadata (status, type, address) is available ' +
    'from admin_list_projects. Project IDs from this tool are compatible with ' +
    'dm_list_top_folders, issues_*, reviews_*, and aecdm_* tools.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'dm' },
  scopes: ['data:read'],
  inputSchema,

  getHubId: (i) => i.hub_id,

  execute: async (input, ctx) => {
    const projects = (await listProjects(ctx.auth, input.hub_id)).filter((p) =>
      isProjectAllowed(p.id),
    );

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
