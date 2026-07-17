import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listRootCauses } from '../../apis/issues.js';

const inputSchema = z.object({
  project_id: z.string().min(1).describe('ACC project ID.'),
});

export const listRootCausesTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_list_root_causes',
  title: 'List Issue Root Cause Categories',
  description:
    'Lists the root cause categories and their sub-causes configured for an ACC project. ' +
    'The IDs returned are the values the root_cause_id field of issues_create and ' +
    'issues_update accepts.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,
  getProjectId: (i) => i.project_id,

  execute: async (input, ctx) => {
    const categories = await listRootCauses(ctx.auth, input.project_id);

    if (categories.length === 0) {
      return {
        content: [{ type: 'text', text: 'No root cause categories configured for this project.' }],
        structuredContent: { categories: [] },
      };
    }

    const lines: string[] = [];
    for (const cat of categories) {
      lines.push(`▸ ${cat.title}  (category ID: ${cat.id})`);
      for (const rc of cat.rootCauses ?? []) {
        lines.push(`    • ${rc.title}  (root cause ID: ${rc.id})`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `${categories.length} root cause category(ies):\n\n${lines.join('\n')}`,
        },
      ],
      structuredContent: { categories },
    };
  },
};
