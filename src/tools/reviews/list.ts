import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listReviews } from '../../apis/reviews.js';

const inputSchema = z.object({
  hub_id: z.string().min(1).describe('Hub ID from dm_list_hubs.'),
  project_id: z.string().min(1).describe('ACC project ID.'),
  status: z
    .enum(['OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'VOID'])
    .optional()
    .describe('Filter by review status.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max results per page.'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
});

export const listReviewsTool: ReadToolDef<typeof inputSchema> = {
  name: 'reviews_list',
  title: 'List Project Reviews',
  description:
    'Lists document/design reviews in an ACC project. ' +
    'Returns review IDs, names, statuses, and due dates. ' +
    'Use reviews_get for full details on a specific review. ' +
    'Requires hub_id from dm_list_hubs to resolve the Reviews container ID.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getHubId: (i) => i.hub_id,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const { results, pagination } = await listReviews(ctx.auth, input.hub_id, input.project_id, {
      limit: input.limit,
      offset: input.offset,
      ...(input.status ? { status: input.status } : {}),
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No reviews found.' }],
        structuredContent: { reviews: [], pagination },
      };
    }

    const lines = results.map(
      (r) =>
        `• [${r.status}] ${r.name}  (ID: ${r.id})` +
        (r.dueDate ? `  due ${r.dueDate}` : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${pagination.totalResults} review(s) (showing ${results.length}):\n\n` +
            lines.join('\n'),
        },
      ],
      structuredContent: { reviews: results, pagination },
    };
  },
};
