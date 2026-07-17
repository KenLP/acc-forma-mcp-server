import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getReview } from '../../apis/reviews.js';

const inputSchema = z.object({
  hub_id: z.string().min(1).describe('Hub ID from dm_list_hubs.'),
  project_id: z.string().min(1).describe('ACC project ID.'),
  review_id: z.string().min(1).describe('Review ID from reviews_list.'),
});

export const getReviewTool: ReadToolDef<typeof inputSchema> = {
  name: 'reviews_get',
  title: 'Get Review Details',
  description:
    'Returns full details of a single ACC review: reviewers, description, status, and ' +
    'timestamps. Read-only — the review status is changed by reviews_transition. Takes both ' +
    'hub_id and project_id, since the Reviews container ID is resolved from the hub.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getHubId: (i) => i.hub_id,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const review = await getReview(ctx.auth, input.hub_id, input.project_id, input.review_id);

    const lines = [
      `Name:       ${review.name}`,
      `ID:         ${review.id}`,
      `Status:     ${review.status}`,
      ...(review.description ? [`Description: ${review.description}`] : []),
      ...(review.dueDate ? [`Due Date:   ${review.dueDate}`] : []),
      ...(review.reviewerIds?.length
        ? [`Reviewers:  ${review.reviewerIds.join(', ')}`]
        : []),
      ...(review.createdBy ? [`Created By: ${review.createdBy}`] : []),
      ...(review.createdAt ? [`Created:    ${review.createdAt}`] : []),
      ...(review.updatedAt ? [`Updated:    ${review.updatedAt}`] : []),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { review },
    };
  },
};
