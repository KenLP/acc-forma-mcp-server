import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getIssue } from '../../apis/issues.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('ACC project ID.'),
  issue_id: z
    .string()
    .min(1)
    .describe('Issue ID from issues_list.'),
});

export const getIssueTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_get',
  title: 'Get Issue Details',
  description:
    'Gets full details of a single issue, including description, location, root cause, ' +
    'due date, and timestamps. Use issues_list first to find issue IDs.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const issue = await getIssue(ctx.auth, input.project_id, input.issue_id);

    const lines = [
      `Title:       ${issue.title}`,
      `ID:          ${issue.id}`,
      `Status:      ${issue.status}`,
      `Subtype ID:  ${issue.issueSubtypeId}`,
      ...(issue.description ? [`Description: ${issue.description}`] : []),
      ...(issue.assignedTo ? [`Assigned To: ${issue.assignedTo}`] : []),
      ...(issue.dueDate ? [`Due Date:    ${issue.dueDate}`] : []),
      ...(issue.locationId ? [`Location ID: ${issue.locationId}`] : []),
      ...(issue.rootCauseId ? [`Root Cause:  ${issue.rootCauseId}`] : []),
      ...(issue.createdAt ? [`Created:     ${issue.createdAt}`] : []),
      ...(issue.updatedAt ? [`Updated:     ${issue.updatedAt}`] : []),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { issue },
    };
  },
};
