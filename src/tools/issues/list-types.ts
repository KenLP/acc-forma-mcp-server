import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listIssueTypes } from '../../apis/issues.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('ACC project ID.'),
});

export const listIssueTypesTool: ReadToolDef<typeof inputSchema> = {
  name: 'issues_list_types',
  title: 'List Issue Types and Subtypes',
  description:
    'Lists all issue types and their subtypes for a project. issues_create takes ' +
    'an issue_subtype_id, not an issue_type_id. Each subtype includes an ' +
    'isActive flag; only active subtypes can be used in issues_create. Inactive ' +
    'subtypes are tagged [INACTIVE] in the text rendering.',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const types = await listIssueTypes(ctx.auth, input.project_id);

    if (types.length === 0) {
      return {
        content: [{ type: 'text', text: 'No issue types configured for this project.' }],
        structuredContent: { types: [] },
      };
    }

    const lines: string[] = [];
    for (const t of types) {
      lines.push(`▸ ${t.title}  (type ID: ${t.id})`);
      for (const s of t.subtypes) {
        const inactiveTag = s.isActive ? '' : '  [INACTIVE]';
        lines.push(`    • ${s.title}  (subtype ID: ${s.id})${inactiveTag}`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `${types.length} issue type(s) with ${types.reduce((n, t) => n + t.subtypes.length, 0)} subtype(s):\n\n` +
            lines.join('\n') +
            '\n\nUse the subtype ID in issues_create (issue_subtype_id field).',
        },
      ],
      structuredContent: { types },
    };
  },
};
