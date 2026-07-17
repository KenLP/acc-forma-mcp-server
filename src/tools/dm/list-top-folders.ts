import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listTopFolders } from '../../apis/data-management.js';

const inputSchema = z.object({
  hub_id: z.string().min(1).describe('Hub ID from dm_list_hubs.'),
  project_id: z
    .string()
    .min(1)
    .describe('Project ID from dm_list_projects. Accepts with or without b. prefix.'),
});

export const listTopFoldersTool: ReadToolDef<typeof inputSchema> = {
  name: 'dm_list_top_folders',
  title: 'List Top-Level Folders',
  description:
    'Lists the root (top-level) folders of a project in Forma Data Management. ' +
    'These are the entry points to the project file tree (e.g., "Plans", "Project Files"). ' +
    'Use the returned folder IDs with dm_list_folder_contents to drill down.',
  kind: 'read',
  preferredAuth: '2lo',
  scope: { kind: 'dm' },
  scopes: ['data:read'],
  inputSchema,

  getHubId: (i) => i.hub_id,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const folders = await listTopFolders(ctx.auth, input.hub_id, input.project_id);

    if (folders.length === 0) {
      return {
        content: [{ type: 'text', text: 'No top-level folders found in this project.' }],
        structuredContent: { folders: [] },
      };
    }

    const lines = folders.map(
      (f) =>
        `• [${f.type}] ${f.name}  (ID: ${f.id})` +
        (f.objectCount !== undefined ? `  [${f.objectCount} items]` : ''),
    );

    return {
      content: [
        {
          type: 'text',
          text: `Found ${folders.length} top-level folder(s):\n\n${lines.join('\n')}`,
        },
      ],
      structuredContent: { folders },
    };
  },
};
