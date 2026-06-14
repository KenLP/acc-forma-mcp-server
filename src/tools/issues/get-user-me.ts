import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getIssueUserMe } from '../../apis/issues.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      'ACC project ID (with or without b. prefix). ' +
        'Get from dm_list_projects or admin_list_projects.',
    ),
});

export const getIssueUserMeTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_get_user_me',
  title: 'Get Current User Issues Permissions',
  description:
    "Returns the current authenticated identity's profile and permission flags for the " +
    'ACC Issues module in a specific project.\n\n' +
    'Use this tool to check:\n' +
    '  • Whether the current SSA / user can create or update issues\n' +
    '  • Whether comments are allowed\n' +
    '  • The identity name and email visible in issue activity feeds\n\n' +
    'Useful as a pre-flight check before running issues_create or issues_update.\n\n' +
    'Auth: SSA or 3LO required (2LO not supported for Issues API).',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx): Promise<import('../_types.js').McpToolResult> => {
    const profile = await getIssueUserMe(ctx.auth, input.project_id);

    const flag = (v: boolean | undefined): string => (v ? '✓ Yes' : '✗ No');

    const lines: string[] = [
      `Identity: ${profile.name ?? '(unknown)'} <${profile.email ?? '?'}>`,
      `ID:       ${profile.id ?? '(unknown)'}`,
      '',
      'Permissions:',
      `  Create issues:   ${flag(profile.canCreateIssues)}`,
      `  Update issues:   ${flag(profile.canUpdateIssues)}`,
      `  Add comments:    ${flag(profile.canCreateComments)}`,
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { profile },
    };
  },
};
