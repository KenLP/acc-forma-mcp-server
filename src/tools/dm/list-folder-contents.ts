import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listFolderContents } from '../../apis/data-management.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('Project ID from dm_list_projects. Accepts with or without b. prefix.'),
  folder_id: z
    .string()
    .min(1)
    .describe(
      'Folder ID from dm_list_top_folders or a previous dm_list_folder_contents call.',
    ),
});

export const listFolderContentsTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_list_folder_contents',
  title: 'List Folder Contents',
  description:
    'Lists the contents of a folder in Forma Data Management. ' +
    'Returns sub-folders and items (files/documents). ' +
    'For items, use dm_get_item to fetch full metadata and dm_list_versions for version history.',
  kind: 'read',
  preferredAuth: '2lo',
  scopes: ['data:read'],
  inputSchema,

  execute: async (input, ctx) => {
    const items = await listFolderContents(ctx.auth, input.project_id, input.folder_id);

    if (items.length === 0) {
      return {
        content: [{ type: 'text', text: 'Folder is empty.' }],
        structuredContent: { items: [] },
      };
    }

    const folders = items.filter((i) => i.type === 'folders');
    const files = items.filter((i) => i.type === 'items');

    const lines = [
      ...folders.map((f) => `📁 ${f.name}  (ID: ${f.id})`),
      ...files.map((f) => `📄 ${f.name}  (ID: ${f.id})`),
    ];

    return {
      content: [
        {
          type: 'text',
          text:
            `${folders.length} folder(s), ${files.length} item(s):\n\n` +
            lines.join('\n'),
        },
      ],
      structuredContent: { items, folders, files },
    };
  },
};
