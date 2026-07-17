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
    'Returns full details of a single ACC issue: description, location, root cause, due ' +
    'date, timestamps, and the permittedStatuses / permittedAttributes that indicate which ' +
    'transitions and edits the current identity may make. Issue IDs come from issues_list.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getProjectId: (i) => i.project_id,

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
