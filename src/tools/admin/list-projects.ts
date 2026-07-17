import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { adminListProjects } from '../../apis/admin.js';
import { isProjectAllowed, isAllowlistActive } from '../../safety/allowlist.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe('Hub (Account) ID. Get from dm_list_hubs. Accepts with or without b. prefix.'),
  status: z
    .enum(['active', 'inactive', 'archived'])
    .optional()
    .describe('Filter by project status. Omit to return all.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max results per page.'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
});

export const adminListProjectsTool: ReadToolDef<typeof inputSchema> = {
  name: 'admin_list_projects',
  title: 'List Forma Projects (Admin)',
  description:
    'Lists the projects in a Forma hub via the Account Admin API, with richer metadata ' +
    'than dm_list_projects: status, type, dates, and address. Takes a hub id, which ' +
    'dm_list_hubs returns. Requires the service account to hold the Account Admin role.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'dm' },
  scopes: ['account:read'],
  inputSchema,

  getHubId: (i) => i.hub_id,

  execute: async (input, ctx) => {
    const { results, pagination } = await adminListProjects(ctx.auth, input.hub_id, {
      limit: input.limit,
      offset: input.offset,
      ...(input.status ? { status: input.status } : {}),
    });

    // Account Admin API returns every project in the hub regardless of the allow-list;
    // filter this page before it reaches the caller. `pagination.totalResults` as returned
    // by APS is the count across ALL pages of the UNFILTERED set — it is NOT this page's
    // size, and it is NOT recoverable by substituting `projects.length` (that's only this
    // page's filtered count, not a cross-page total; page 1 could show 0 while allowed
    // projects exist on page 2). So:
    //   - allow-list inactive (nothing filtered): nothing to hide, pass APS's pagination
    //     (including the real totalResults) through unchanged.
    //   - allow-list active: the true allowed-total is unknowable without scanning every
    //     APS page, and the APS totalResults would leak how many projects exist outside the
    //     allow-list either way (correct or "fixed"). Omit totalResults entirely rather than
    //     report a number that's wrong in either direction. Do NOT "fix" this back to
    //     projects.length — see the regression that guards against exactly that in
    //     tests/unit/tools/admin/list-projects.spec.ts.
    const projects = results.filter((p) => isProjectAllowed(p.id));
    const filteredPagination = isAllowlistActive()
      ? { limit: pagination.limit, offset: pagination.offset }
      : pagination;

    if (projects.length === 0) {
      return {
        content: [{ type: 'text', text: 'No projects found on this page.' }],
        structuredContent: { projects: [], pagination: filteredPagination },
      };
    }

    const lines = projects.map(
      (p) =>
        `• ${p.name}  (ID: ${p.id})  [status: ${p.status}${p.type ? ', type: ' + p.type : ''}]`,
    );

    return {
      content: [
        {
          type: 'text',
          text: `Found ${projects.length} project(s) on this page:\n\n` + lines.join('\n'),
        },
      ],
      structuredContent: { projects, pagination: filteredPagination },
    };
  },
};
