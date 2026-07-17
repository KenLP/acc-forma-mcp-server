import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listIssueAttachments } from '../../apis/issues.js';

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
    .describe('Issue ID to list attachments for. Get from issues_list or issues_get.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe('Maximum number of attachments to return (1–100, default 50).'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset (default 0).'),
});

export const listIssueAttachmentsTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_list_attachments',
  title: 'List Issue Attachments',
  description:
    'Returns the attachments (files, photos, links) associated with an ACC issue.\n\n' +
    'Each attachment entry includes:\n' +
    '  • `id` — attachment ID\n' +
    '  • `name` — display name of the file or link\n' +
    '  • `urn` — Data Management URN of the linked file (for DM-type attachments)\n' +
    '  • `attachmentType` — "dm" for DM files, "url" for external links\n' +
    '  • `createdBy` / `createdAt` — authorship\n\n' +
    'Auth: SSA or 3LO required (2LO not supported for Issues API).',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const { results, pagination } = await listIssueAttachments(
      ctx.auth,
      input.project_id,
      input.issue_id,
      { limit: input.limit, offset: input.offset },
    );

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No attachments found for this issue.' }],
        structuredContent: { attachments: [], pagination },
      };
    }

    const lines = results.map((a) => {
      const type = a.attachmentType ? ` [${a.attachmentType}]` : '';
      const urn = a.urn ? `\n  URN: ${a.urn}` : '';
      const by = a.createdBy ? ` by ${a.createdBy}` : '';
      const ts = a.createdAt ? ` on ${a.createdAt.slice(0, 10)}` : '';
      return `• ${a.name ?? '(unnamed)'}${type}  ID: ${a.id}${urn}\n  Added${by}${ts}`;
    });

    const header =
      `${pagination.totalResults} attachment(s) total — ` +
      `showing ${input.offset + 1}–${input.offset + results.length}:`;

    return {
      content: [{ type: 'text', text: `${header}\n\n${lines.join('\n\n')}` }],
      structuredContent: { attachments: results, pagination },
    };
  },
};
