import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listItemVersions } from '../../apis/data-management.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('Project ID from dm_list_projects. Accepts with or without b. prefix.'),
  item_id: z
    .string()
    .min(1)
    .describe('Item ID from dm_list_folder_contents or dm_get_item.'),
});

export const listVersionsTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_list_versions',
  title: 'List Item Versions',
  description:
    'Lists all versions of a file/item in Forma Data Management, ordered newest first. ' +
    'Returns version number, file type, size, and timestamps. ' +
    'Useful for tracking document history and identifying which version is current.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'dm' },
  scopes: ['data:read'],
  inputSchema,

  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const versions = await listItemVersions(ctx.auth, input.project_id, input.item_id);

    if (versions.length === 0) {
      return {
        content: [{ type: 'text', text: 'No versions found for this item.' }],
        structuredContent: { versions: [] },
      };
    }

    const lines = versions.map(
      (v) =>
        `• v${v.versionNumber}  ${v.name}` +
        (v.fileType ? `  [${v.fileType}]` : '') +
        (v.storageSize !== undefined ? `  (${Math.round(v.storageSize / 1024)} KB)` : '') +
        (v.createTime ? `  ${v.createTime.slice(0, 10)}` : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text: `${versions.length} version(s):\n\n${lines.join('\n')}`,
        },
      ],
      structuredContent: { versions },
    };
  },
};
