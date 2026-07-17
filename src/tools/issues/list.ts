import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listIssues } from '../../apis/issues.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('ACC project ID. Get from dm_list_projects or admin_list_projects.'),
  status: z
    .enum(['open', 'pending', 'in_review', 'closed', 'void'])
    .optional()
    .describe('Filter by issue status.'),
  assigned_to: z
    .string()
    .optional()
    .describe('Filter by assignee Autodesk user ID.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max results per page.'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
});

export const listIssuesTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_list',
  title: 'List Project Issues',
  description:
    'Lists issues in an ACC project. Supports filtering by status and assignee. ' +
    'Returns issue IDs, titles, statuses, and assignments. ' +
    'Use issues_get for full details on a specific issue.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const { results, pagination } = await listIssues(ctx.auth, input.project_id, {
      limit: input.limit,
      offset: input.offset,
      ...(input.status ? { status: input.status } : {}),
      ...(input.assigned_to ? { assignedTo: input.assigned_to } : {}),
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No issues found matching the filters.' }],
        structuredContent: { issues: [], pagination },
      };
    }

    const lines = results.map(
      (i) =>
        `• [${i.status.toUpperCase()}] ${i.title}  (ID: ${i.id})` +
        (i.assignedTo ? `  → ${i.assignedTo}` : '') +
        (i.dueDate ? `  due ${i.dueDate}` : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${pagination.totalResults} issue(s) (showing ${results.length}):\n\n` +
            lines.join('\n'),
        },
      ],
      structuredContent: { issues: results, pagination },
    };
  },
};
