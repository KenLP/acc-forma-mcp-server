import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { createReview } from '../../apis/reviews.js';
import { registerValidator, BusinessRuleError } from '../../safety/business-rules.js';
import { stripBPrefix } from '../../utils/project-id.js';

const inputSchema = z.object({
  project_id: z.string().min(1).describe('ACC project ID.'),
  name: z.string().min(1).max(500).describe('Review name (required, max 500 characters).'),
  workflow_id: z
    .string()
    .min(1)
    .describe(
      'Approval workflow the review runs through (required). Workflow IDs come from ' +
        'reviews_list_workflows. The workflow defines the approval steps and who approves ' +
        'each one — reviewers are not listed on the review itself.',
    ),
  file_versions: z
    .array(
      z.object({
        urn: z
          .string()
          .min(1)
          .describe('Versioned file URN, including the ?version=N suffix.'),
      }),
    )
    .min(1)
    .describe(
      'File versions submitted into the review (at least one). Version URNs come from ' +
        'dm_list_versions.',
    ),
});

// The API rejects a version URN without an explicit version suffix with a format error that
// names an internal type ("should match format \"versionedFileUrn\""). Catching it here turns
// that into something a caller can act on, and does so before the approval token is issued.
// eslint-disable-next-line @typescript-eslint/require-await
registerValidator<z.infer<typeof inputSchema>>('reviews_create', async (input) => {
  const passed: string[] = [];
  const unversioned = input.file_versions.filter((f) => !/\?version=\d+$/.test(f.urn));
  if (unversioned.length > 0) {
    throw new BusinessRuleError(
      'file_version_urn_must_be_versioned',
      `${unversioned.length} of ${input.file_versions.length} file_versions URN(s) lack a ` +
        `"?version=N" suffix — ACC requires a specific version, not a file lineage. ` +
        `First offender: ${unversioned[0]?.urn}`,
    );
  }
  passed.push('file_version_urns_are_versioned');
  return { passed };
});

export const createReviewTool: MutationToolDef<typeof inputSchema> = {
  name: 'reviews_create',
  title: 'Create Review',
  description:
    'Starts a review of one or more file versions in an ACC project, running them through an ' +
    'existing approval workflow. Workflow IDs come from reviews_list_workflows and version ' +
    'URNs from dm_list_versions. Approvers are defined by the workflow, not by this call.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,

  getProjectId: (input) => input.project_id,

  // eslint-disable-next-line @typescript-eslint/require-await
  buildPreview: async (input) => {
    const url =
      `https://developer.api.autodesk.com/construction/reviews/v1/projects/` +
      `${stripBPrefix(input.project_id)}/reviews`;

    const body = {
      name: input.name,
      workflowId: input.workflow_id,
      fileVersions: input.file_versions.map((f) => ({ urn: f.urn })),
    };

    return {
      method: 'POST',
      url,
      body,
      sideEffects: [
        `Create review "${input.name}" in project ${input.project_id}`,
        `Submit ${input.file_versions.length} file version(s) into workflow ${input.workflow_id}`,
        'Notify the approvers the workflow assigns to its first step',
      ],
      businessRulesPassed: ['file_version_urns_are_versioned'],
      executePayload: { toolName: 'reviews_create', projectId: input.project_id, body },
    };
  },

  execute: async (input, ctx) => {
    const review = await createReview(ctx.auth, input.project_id, {
      name: input.name,
      workflowId: input.workflow_id,
      fileVersions: input.file_versions.map((f) => ({ urn: f.urn })),
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `Created review "${review.name}"\n` +
            `ID:     ${review.id}\n` +
            `Status: ${review.status}`,
        },
      ],
      structuredContent: { review },
    };
  },
};
