import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { adminListProjects } from '../../apis/admin.js';
import { isProjectAllowed, isProjectAllowlistActive } from '../../safety/allowlist.js';

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
    const { results, pagination: rawPagination } = await adminListProjects(ctx.auth, input.hub_id, {
      limit: input.limit,
      offset: input.offset,
      ...(input.status ? { status: input.status } : {}),
    });

    // Account Admin API returns every project in the hub regardless of the allow-list;
    // filter this page before it reaches the caller. `rawPagination.totalResults` as
    // returned by APS is the count across ALL pages of the UNFILTERED set — it is NOT this
    // page's size, and it is NOT recoverable by substituting `projects.length` (that's only
    // this page's filtered count, not a cross-page total; page 1 could show 0 while allowed
    // projects exist on page 2). So:
    //   - project allow-list inactive (nothing filtered by isProjectAllowed): nothing to
    //     hide, pass APS's totalResults through unchanged. This must key off the PROJECT
    //     allow-list specifically, not isAllowlistActive() — a narrowed FORMA_ALLOWED_HUBS
    //     with FORMA_ALLOWED_PROJECTS='*' filters nothing here and must not degrade the
    //     response.
    //   - project allow-list active: the true allowed-total is unknowable without scanning
    //     every APS page, and the APS totalResults would leak how many projects exist
    //     outside the allow-list either way (correct or "fixed"). Omit totalResults entirely
    //     rather than report a number that's wrong in either direction. Do NOT "fix" this
    //     back to projects.length — see the regression that guards against exactly that in
    //     tests/unit/tools/admin/list-projects.spec.ts.
    const projects = results.filter((p) => isProjectAllowed(p.id));

    // Continuation contract, computed from the RAW (unfiltered) APS page — limit/offset
    // address APS's result set, not the filtered one, so a caller must be able to page
    // through the whole hub even when an entire page's allowed set is empty (allowed
    // projects can sit on a later page than the one that filtered to zero rows).
    // AdminPagination.totalResults is a required field on every adminListProjects response
    // (defaulted to 0 only if APS omits the pagination block entirely), so it is always
    // available here and `offset + results.length < totalResults` is exact — no need for
    // the `results.length === limit` fallback in that degenerate case.
    const hasMore = rawPagination.offset + results.length < rawPagination.totalResults;
    const nextOffset = hasMore ? rawPagination.offset + results.length : null;

    // NOTE: hasMore/nextOffset do reveal that more rows exist in the hub beyond this page,
    // even when every one of those rows is filtered out by the allow-list. That is a far
    // weaker signal than an exact unfiltered total (it says "more exist", not "how many"),
    // and without it the tool cannot be paginated at all once an allow-list is active. This
    // is a deliberate trade, not an oversight.
    const pagination = isProjectAllowlistActive()
      ? { limit: rawPagination.limit, offset: rawPagination.offset, hasMore, nextOffset }
      : { ...rawPagination, hasMore, nextOffset };

    if (projects.length === 0) {
      return {
        content: [{ type: 'text', text: 'No projects found on this page.' }],
        structuredContent: { projects: [], pagination },
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
      structuredContent: { projects, pagination },
    };
  },
};
