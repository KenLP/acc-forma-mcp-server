import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { createReview, resolveReviewsContainerId } from '../../apis/reviews.js';
import { registerValidator, BusinessRuleError } from '../../safety/business-rules.js';

const inputSchema = z.object({
  hub_id: z.string().min(1).describe('Hub ID from dm_list_hubs.'),
  project_id: z
    .string()
    .min(1)
    .describe('ACC project ID.'),
  name: z
    .string()
    .min(1)
    .max(500)
    .describe('Review name (required, max 500 characters).'),
  reviewer_ids: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'List of Autodesk user IDs to add as reviewers (required, at least 1). ' +
        'Use admin_list_users to find user IDs.',
    ),
  description: z
    .string()
    .max(10_000)
    .optional()
    .describe('Optional review description.'),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO 8601 date: YYYY-MM-DD')
    .optional()
    .describe('Due date in YYYY-MM-DD format. Must be today or in the future.'),
  workflow_id: z
    .string()
    .optional()
    .describe(
      'Review workflow template ID (optional). ' +
        'If omitted, the project default workflow is used. ' +
        'Workflows define the approval sequence (sequential vs parallel).',
    ),
  linked_documents: z
    .array(
      z.object({
        version_urn: z
          .string()
          .min(1)
          .describe('Version URN of the model to attach (from dm_list_versions).'),
      }),
    )
    .optional()
    .describe(
      'Model version URNs to attach to this review. ' +
        'Use dm_list_versions to get version URNs.',
    ),
});

// eslint-disable-next-line @typescript-eslint/require-await
registerValidator<z.infer<typeof inputSchema>>('reviews_create', async (input) => {
  const passed: string[] = [];
  if (input.due_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (input.due_date < today) {
      throw new BusinessRuleError(
        'due_date_must_be_future',
        `due_date "${input.due_date}" is in the past (today is ${today}). Provide a current or future date.`,
      );
    }
    passed.push('due_date_is_current_or_future');
  }
  return { passed };
});

export const createReviewTool: MutationToolDef<typeof inputSchema> = {
  name: 'reviews_create',
  title: 'Create Review',
  description:
    'Creates a new review in an ACC project. reviewer_ids are Autodesk user IDs; ' +
    'linked_documents reference model version URNs to attach. ' +
    'Resolving the Reviews container requires hub_id in addition to project_id.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  getHubId: (input) => input.hub_id,
  getProjectId: (input) => input.project_id,

  buildPreview: async (input, ctx) => {
    const containerId = await resolveReviewsContainerId(ctx.auth, input.hub_id, input.project_id);
    const url = `https://developer.api.autodesk.com/construction/reviews/v1/containers/${containerId}/reviews`;

    const body = {
      name: input.name,
      reviewerIds: input.reviewer_ids,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.due_date !== undefined ? { dueDate: input.due_date } : {}),
      ...(input.workflow_id !== undefined ? { workflowId: input.workflow_id } : {}),
      ...(input.linked_documents !== undefined
        ? { linkedDocuments: input.linked_documents.map((d) => ({ versionUrn: d.version_urn })) }
        : {}),
    };

    const sideEffects = [
      `Create review "${input.name}" in project ${input.project_id}`,
      `Send review invitations to ${input.reviewer_ids.length} reviewer(s)`,
      ...(input.linked_documents?.length
        ? [`Attach ${input.linked_documents.length} model version(s) to review`]
        : []),
    ];

    return {
      method: 'POST',
      url,
      body,
      sideEffects,
      businessRulesPassed: [
        ...(input.due_date ? ['due_date_is_current_or_future'] : []),
      ],
      executePayload: { toolName: 'reviews_create', containerId, body },
    };
  },

  execute: async (input, ctx) => {
    const review = await createReview(ctx.auth, input.hub_id, input.project_id, {
      name: input.name,
      reviewerIds: input.reviewer_ids,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.due_date !== undefined ? { dueDate: input.due_date } : {}),
      ...(input.workflow_id !== undefined ? { workflowId: input.workflow_id } : {}),
      ...(input.linked_documents !== undefined
        ? { linkedDocuments: input.linked_documents.map((d) => ({ versionUrn: d.version_urn })) }
        : {}),
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `Review created successfully.\n` +
            `ID:     ${review.id}\n` +
            `Name:   ${review.name}\n` +
            `Status: ${review.status}`,
        },
      ],
      structuredContent: { review },
    };
  },
};
