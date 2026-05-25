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
    'Gets full details of a single review, including reviewers, description, and timestamps. ' +
    'Use reviews_transition to change the review status. ' +
    'Requires hub_id from dm_list_hubs to resolve the Reviews container ID.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

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
