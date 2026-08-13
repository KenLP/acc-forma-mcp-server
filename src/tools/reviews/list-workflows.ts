import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listWorkflows } from '../../apis/reviews.js';

const inputSchema = z.object({
  project_id: z.string().min(1).describe('ACC project ID.'),
});

export const listReviewWorkflowsTool: ReadToolDef<typeof inputSchema> = {
  name: 'reviews_list_workflows',
  title: 'List Review Approval Workflows',
  description:
    'Lists the approval workflow definitions available in an ACC project, returning each ' +
    "workflow's ID, name, and status. A workflow defines the approval steps a review passes " +
    'through and who approves each one. The IDs returned here are the workflow_id that ' +
    'reviews_create requires.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const { results } = await listWorkflows(ctx.auth, input.project_id);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No approval workflows found in this project. A workflow must exist before a ' +
              'review can be created; workflows are set up in the ACC Reviews tool.',
          },
        ],
        structuredContent: { workflows: [] },
      };
    }

    const lines = results.map(
      (w) => `• ${w.name}  (ID: ${w.id})` + (w.status ? `  [${w.status}]` : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} approval workflow(s):\n\n${lines.join('\n')}`,
        },
      ],
      structuredContent: { workflows: results },
    };
  },
};
