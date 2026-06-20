import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listModelSets } from '../../apis/model-coordination.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      'ACC project ID (with or without b. prefix). Get from dm_list_projects or admin_list_projects.',
    ),
});

export const mcListModelSetsTool: ReadToolDef<typeof inputSchema> = {
  name: 'mc_list_modelsets',
  title: 'List Model Coordination Modelsets',
  description:
    '**Model Coordination API** — lists the coordination modelsets (coordination spaces) in a project.\n\n' +
    'A modelset is a folder of models that ACC continuously clash-tests against each other. ' +
    'Use the returned `modelSetId` with `mc_list_clashes` to pull clash results.\n\n' +
    '⚠️ **Prerequisites:**\n' +
    '  • Model Coordination must be activated on the project and a coordination space set up.\n' +
    '  • The authenticated SSA must have **Model Coordination product access** ' +
    '(Member or Administrator) — without it the API returns 404 "no access". Grant it in ' +
    'ACC Project Admin → Members.\n\n' +
    'Auth: SSA or 3LO (2LO not accepted).',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const modelSets = await listModelSets(ctx.auth, input.project_id);

    if (modelSets.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No modelsets found. Either Model Coordination has no coordination space configured ' +
              'in this project, or the SSA lacks Model Coordination access (grant it in Project Admin → Members).',
          },
        ],
        structuredContent: { modelSets: [] },
      };
    }

    const lines = modelSets.map((m) => {
      const flags = [m.isDisabled ? 'disabled' : 'active'];
      if (m.includedFolderCount !== undefined) flags.push(`${m.includedFolderCount} folder(s)`);
      if (m.clashEngineVersion !== undefined) flags.push(`clash engine v${m.clashEngineVersion}`);
      return `• ${m.name}\n  modelSetId: ${m.modelSetId}  (${flags.join(', ')})`;
    });

    return {
      content: [
        {
          type: 'text',
          text: `${modelSets.length} modelset(s):\n\n${lines.join('\n')}`,
        },
      ],
      structuredContent: { modelSets },
    };
  },
};
