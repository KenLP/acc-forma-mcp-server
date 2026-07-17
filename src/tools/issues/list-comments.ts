import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listIssueComments } from '../../apis/issues.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      'ACC project ID (with or without b. prefix). ' +
        'Get from dm_list_projects or admin_list_projects.',
    ),
  issue_id: z
    .string()
    .min(1)
    .describe('Issue ID to retrieve comments for. Get from issues_list or issues_get.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe('Maximum number of comments to return (1–100, default 50).'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset (default 0).'),
});

export const listIssueCommentsTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_list_comments',
  title: 'List Issue Comments',
  description:
    'Returns the comment thread for a specific ACC issue, ordered chronologically. Each ' +
    'comment carries its ID, body text, author, and timestamps. Read-only — new comments ' +
    'are posted by issues_add_comment. The Issues API accepts SSA or 3LO auth only.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const { results, pagination } = await listIssueComments(
      ctx.auth,
      input.project_id,
      input.issue_id,
      { limit: input.limit, offset: input.offset },
    );

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No comments found for this issue.' }],
        structuredContent: { comments: [], pagination },
      };
    }

    const lines = results.map((c, i) => {
      const ts = c.createdAt ? ` (${c.createdAt.slice(0, 10)})` : '';
      const by = c.createdBy ? ` by ${c.createdBy}` : '';
      return `${input.offset + i + 1}. [${c.id}]${by}${ts}\n   ${c.body}`;
    });

    const header =
      `${pagination.totalResults} comment(s) total — ` +
      `showing ${input.offset + 1}–${input.offset + results.length}:`;

    return {
      content: [{ type: 'text', text: `${header}\n\n${lines.join('\n\n')}` }],
      structuredContent: { comments: results, pagination },
    };
  },
};
