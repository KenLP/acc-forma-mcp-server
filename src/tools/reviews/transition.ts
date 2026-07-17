import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { transitionReview, resolveReviewsContainerId } from '../../apis/reviews.js';

const inputSchema = z.object({
  hub_id: z.string().min(1).describe('Hub ID from dm_list_hubs.'),
  project_id: z.string().min(1).describe('ACC project ID.'),
  review_id: z.string().min(1).describe('Review ID from reviews_list.'),
  action: z
    .enum(['SUBMIT', 'APPROVE', 'REJECT', 'VOID', 'REOPEN'])
    .describe(
      'Transition action to apply:\n' +
        '  SUBMIT  — move from OPEN to IN_REVIEW\n' +
        '  APPROVE — approve an IN_REVIEW review\n' +
        '  REJECT  — reject an IN_REVIEW review\n' +
        '  VOID    — void/cancel a review\n' +
        '  REOPEN  — reopen a closed review',
    ),
  comment: z
    .string()
    .max(5_000)
    .optional()
    .describe('Optional comment to attach to this transition.'),
});

export const transitionReviewTool: MutationToolDef<typeof inputSchema> = {
  name: 'reviews_transition',
  title: 'Transition Review Status',
  description:
    'Changes the status of an ACC review by applying a transition action. ' +
    'Valid actions: SUBMIT, APPROVE, REJECT, VOID, REOPEN. ' +
    'Resolving the Reviews container requires hub_id in addition to project_id.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  getHubId: (input) => input.hub_id,
  getProjectId: (input) => input.project_id,

  buildPreview: async (input, ctx) => {
    const containerId = await resolveReviewsContainerId(ctx.auth, input.hub_id, input.project_id);
    const url = `https://developer.api.autodesk.com/construction/reviews/v1/containers/${containerId}/reviews/${input.review_id}/transitions`;

    const body = {
      action: input.action,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    };

    return {
      method: 'POST',
      url,
      body,
      sideEffects: [
        `Apply action "${input.action}" to review ${input.review_id}`,
        ...(input.action === 'APPROVE' || input.action === 'REJECT'
          ? ['Notify review creator and reviewers of the decision']
          : []),
      ],
      businessRulesPassed: [],
      executePayload: { toolName: 'reviews_transition', containerId, reviewId: input.review_id, body },
    };
  },

  execute: async (input, ctx) => {
    const review = await transitionReview(ctx.auth, input.hub_id, input.project_id, input.review_id, {
      action: input.action,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `Review transition applied.\n` +
            `Review ID: ${review.id}\n` +
            `New Status: ${review.status}\n` +
            `Action:    ${input.action}`,
        },
      ],
      structuredContent: { review },
    };
  },
};
