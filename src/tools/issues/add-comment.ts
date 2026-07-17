import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { addIssueComment } from '../../apis/issues.js';
import { stripBPrefix } from '../../utils/project-id.js';

const APS_BASE = 'https://developer.api.autodesk.com';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('ACC project ID.'),
  issue_id: z
    .string()
    .min(1)
    .describe('Issue ID from issues_list.'),
  body: z
    .string()
    .min(1)
    .max(10_000)
    .describe('Comment text (max 10,000 characters).'),
});

export const addCommentTool: MutationToolDef<typeof inputSchema> = {
  name: 'issues_add_comment',
  title: 'Add Comment to Issue',
  description: 'Adds a comment to an existing ACC issue.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,

  getProjectId: (input) => input.project_id,

  // eslint-disable-next-line @typescript-eslint/require-await
  buildPreview: async (input, _ctx) => {
    const pid = stripBPrefix(input.project_id);
    const url = `${APS_BASE}/construction/issues/v1/projects/${pid}/issues/${input.issue_id}/comments`;
    const body = { body: input.body };

    return {
      method: 'POST',
      url,
      body,
      sideEffects: [
        `Add comment to issue ${input.issue_id} in project ${input.project_id}`,
        'Send notification to issue subscribers',
      ],
      businessRulesPassed: [],
      executePayload: { toolName: 'issues_add_comment', projectId: pid, issueId: input.issue_id, body },
    };
  },

  execute: async (input, ctx) => {
    const comment = await addIssueComment(ctx.auth, input.project_id, input.issue_id, input.body);

    return {
      content: [
        {
          type: 'text',
          text:
            `Comment added successfully.\n` +
            `Comment ID: ${comment.id}\n` +
            `Issue ID:   ${input.issue_id}`,
        },
      ],
      structuredContent: { comment },
    };
  },
};
