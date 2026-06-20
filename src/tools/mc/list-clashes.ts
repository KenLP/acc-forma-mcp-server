import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getClashResults } from '../../apis/model-coordination.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('ACC project ID (with or without b. prefix).'),
  model_set_id: z
    .string()
    .min(1)
    .describe('Modelset ID from mc_list_modelsets.'),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Modelset version to read clashes for. Omit to use the latest version.'),
  status: z
    .number()
    .int()
    .optional()
    .describe('Filter to a single raw MC status code (1 = active/new in observed data).'),
  min_penetration: z
    .number()
    .positive()
    .optional()
    .describe(
      'Keep only clashes whose penetration depth |distance| ≥ this value (in model units). ' +
        'Use to ignore grazing/near clashes and surface only significant hard clashes.',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe('Maximum clashes to return, sorted by penetration depth (worst first).'),
});

export const mcListClashesTool: ReadToolDef<typeof inputSchema> = {
  name: 'mc_list_clashes',
  title: 'List Model Coordination Clashes',
  description:
    '**Model Coordination API** — returns clash-detection results for a modelset.\n\n' +
    'ACC clash-tests a modelset automatically whenever its models change. This tool resolves the ' +
    'latest (or a given) version\'s clash test, downloads the result files, and joins them into ' +
    'clash pairs — each with the two clashing elements, their source models, and the penetration depth.\n\n' +
    'Each clash side carries:\n' +
    '  • `documentUrn` — the model the element belongs to (file version URN)\n' +
    '  • `viewableName` — the 3D view (e.g. "3D Plumbing")\n' +
    '  • `objectId` / `lmvId` — element identity (lmvId is the viewer dbId, usable for pinning)\n\n' +
    '`distance` is **negative for hard clashes** (the magnitude is the overlap depth in model units); ' +
    'results are sorted worst-first.\n\n' +
    'To turn a clash into a pinned issue, map a side\'s `lmvId` (or look up its externalId via ' +
    'md_get_properties) and use `issues_pin_element`.\n\n' +
    'Auth: SSA or 3LO. The SSA needs Model Coordination product access (see mc_list_modelsets).',
  kind: 'read',
  scopes: ['data:read'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const result = await getClashResults(ctx.auth, input.project_id, input.model_set_id, {
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.min_penetration !== undefined ? { minPenetration: input.min_penetration } : {}),
      maxResults: input.max_results,
    });

    if (result.testId === null) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No completed clash test for modelset ${input.model_set_id} (version ${result.version}). ` +
              `Ensure the coordination space has at least two overlapping models and that ACC has ` +
              `finished computing clashes.`,
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }

    const docLabel = (urn: string): string => {
      const doc = result.documents.find((d) => d.urn === urn);
      return doc ? `${doc.viewableName}` : urn.slice(0, 40);
    };

    const lines = result.clashes.slice(0, 30).map((c) => {
      const sev = c.distance < 0 ? `🔴 ${c.distance.toFixed(4)} (overlap)` : `🟡 ${c.distance.toFixed(4)} (gap)`;
      return (
        `• clash ${c.clashId}  ${sev}  status:${c.status}\n` +
        `  ${docLabel(c.left.documentUrn)} obj ${c.left.objectId} (dbId ${c.left.lmvId})` +
        `  ✕  ${docLabel(c.right.documentUrn)} obj ${c.right.objectId} (dbId ${c.right.lmvId})`
      );
    });

    const hardCount = result.clashes.filter((c) => c.distance < 0).length;
    const truncNote =
      result.clashes.length > 30 ? `\n\n…and ${result.clashes.length - 30} more (raise max_results)` : '';

    const header =
      `Clash test ${result.testId} (status: ${result.testStatus}, modelset version ${result.version}).\n` +
      `${result.totalClashes} total clash(es); ${result.clashes.length} returned ` +
      `(${hardCount} hard/overlapping). Models: ${result.documents.map((d) => d.viewableName).join(', ')}.`;

    return {
      content: [{ type: 'text', text: `${header}\n\n${lines.join('\n\n')}${truncNote}` }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
};
