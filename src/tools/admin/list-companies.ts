import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { adminListCompanies } from '../../apis/admin.js';

const inputSchema = z.object({
  hub_id: z
    .string()
    .min(1)
    .describe('Hub (Account) ID. Get from dm_list_hubs.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max results per page.'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
});

export const adminListCompaniesTool: ReadToolDef<typeof inputSchema> = {
  name: 'admin_list_companies',
  title: 'List Forma Account Companies',
  description:
    'Lists all companies (business units / trade partners) registered in a Forma hub. ' +
    'Returns company IDs, names, trade types, and locations. ' +
    'Requires Account Admin role.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'dm' },
  scopes: ['account:read'],
  inputSchema,

  getHubId: (i) => i.hub_id,

  execute: async (input, ctx) => {
    const { results, pagination } = await adminListCompanies(ctx.auth, input.hub_id, {
      limit: input.limit,
      offset: input.offset,
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No companies found for this hub.' }],
        structuredContent: { companies: [], pagination },
      };
    }

    const lines = results.map(
      (c) =>
        `• ${c.name}  (ID: ${c.id})` +
        (c.tradeType ? `  [${c.tradeType}]` : '') +
        (c.city || c.country
          ? `  ${[c.city, c.country].filter(Boolean).join(', ')}`
          : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${pagination.totalResults} compan(ies) (showing ${results.length}):\n\n` +
            lines.join('\n'),
        },
      ],
      structuredContent: { companies: results, pagination },
    };
  },
};
