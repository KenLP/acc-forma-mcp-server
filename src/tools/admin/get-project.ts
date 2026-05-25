import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { adminGetProject } from '../../apis/admin.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe('Hub (Account) ID. Get from dm.list_hubs.'),
  project_id: z
    .string()
    .min(1)
    .describe('Project ID. Get from admin.list_projects or dm.list_projects.'),
});

export const adminGetProjectTool: ReadToolDef<typeof inputSchema> = {
  name: 'admin_get_project',
  title: 'Get Forma Project Details (Admin)',
  description:
    'Gets full details of a single project from the Account Admin API, ' +
    'including status, type, job number, address, and dates. ' +
    'Requires Account Admin role on the hub.',
  kind: 'read',
  preferredAuth: '2lo',
  scopes: ['account:read'],
  inputSchema,

  execute: async (input, ctx) => {
    const project = await adminGetProject(ctx.auth, input.hub_id, input.project_id);

    const lines = [
      `Name:       ${project.name}`,
      `ID:         ${project.id}`,
      `Status:     ${project.status}`,
      ...(project.type ? [`Type:       ${project.type}`] : []),
      ...(project.jobNumber ? [`Job #:      ${project.jobNumber}`] : []),
      ...(project.startDate ? [`Start:      ${project.startDate}`] : []),
      ...(project.endDate ? [`End:        ${project.endDate}`] : []),
      ...(project.city || project.country
        ? [`Location:   ${[project.city, project.country].filter(Boolean).join(', ')}`]
        : []),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { project },
    };
  },
};
