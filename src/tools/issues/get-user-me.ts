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
    "Returns the calling identity's own permission flags for the ACC Issues module in one " +
    'project — whether it may create or update issues and whether commenting is allowed — ' +
    'together with the profile ACC shows for it in issue activity. Reports on the ' +
    'authenticated service account itself, not on other members. The Issues API accepts ' +
    'SSA or 3LO auth only.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx): Promise<import('../_types.js').McpToolResult> => {
    const profile = await getIssueUserMe(ctx.auth, input.project_id);

    const flag = (v: boolean | undefined): string => (v ? '✓ Yes' : '✗ No');

    // A service account has no ACC user profile, so name and email come back empty. Say what
    // the caller actually is instead of printing "(unknown) <?>".
    // The body is passed through as-is, so an absent field may arrive as undefined, null or "".
    const present = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    const identity = present(profile.name) || present(profile.email)
      ? `${present(profile.name) ? profile.name : '(no name)'} <${present(profile.email) ? profile.email : '?'}>`
      : ctx.robotEmail !== undefined
        ? `service account (robot) <${ctx.robotEmail}> — no ACC user profile`
        : 'service account — no ACC user profile';

    const lines: string[] = [
      `Identity: ${identity}`,
      `ID:       ${profile.id ?? '(unknown)'}`,
      '',
      'Permissions:',
      `  Create issues:   ${flag(profile.canCreateIssues)}`,
      `  Update issues:   ${flag(profile.canUpdateIssues)}`,
      `  Add comments:    ${flag(profile.canCreateComments)}`,
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { profile, ...(ctx.robotEmail !== undefined ? { robotEmail: ctx.robotEmail } : {}) },
    };
  },
};
