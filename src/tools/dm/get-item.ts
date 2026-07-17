import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getItem } from '../../apis/data-management.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('Project ID from dm_list_projects. Accepts with or without b. prefix.'),
  item_id: z
    .string()
    .min(1)
    .describe('Item ID from dm_list_folder_contents.'),
});

export const getItemTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_get_item',
  title: 'Get Item Details',
  description:
    'Returns full metadata for a single item (file/document) in Forma Data Management: ' +
    'item name, type, and tip (latest) version ID. Covers the tip version only — the full ' +
    'version history is available from dm_list_versions.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'dm' },
  scopes: ['data:read'],
  inputSchema,

  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const item = await getItem(ctx.auth, input.project_id, input.item_id);

    const lines = [
      `Name:           ${item.name}`,
      `ID:             ${item.id}`,
      `Type:           ${item.type}`,
      `Hidden:         ${item.hidden}`,
      ...(item.tipVersionId ? [`Latest Version: ${item.tipVersionId}`] : []),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { item },
    };
  },
};
