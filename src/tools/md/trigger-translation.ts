import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { triggerMdTranslation, encodeMdUrn } from '../../apis/model-derivative.js';
import { checkUnscopedToolAllowed } from '../../safety/allowlist.js';

const inputSchema = z.object({
  urn: z
    .string()
    .min(1)
    .describe(
      'Item version URN from Data Management (from dm_list_versions). ' +
        'Accepts raw "urn:adsk..." or base64url-encoded form.',
    ),
  force_regenerate: z
    .boolean()
    .default(false)
    .describe(
      'Force re-translation even if a derivative already exists. ' +
        'Use when the existing derivative is stale or failed.',
    ),
});

export const mdTriggerTranslationTool: MutationToolDef<typeof inputSchema> = {
  name: 'md_trigger_translation',
  title: 'Trigger Model Derivative Translation',
  description:
    '**Model Derivative API (mutation)** — submits a translation job to produce SVF2 output ' +
    'for a model version. SVF2 is required before `md_get_properties` or `md_get_manifest` ' +
    'can return geometry/view data.\n\n' +
    'Translation typically takes 30 seconds – 5 minutes depending on model size. ' +
    'Poll `md_get_manifest` to check status.\n\n' +
    '**API boundary:** this is a Model Derivative mutation, NOT an AECDM or ACC Issues/Reviews operation. ' +
    'It does not modify BIM data — it only generates derivative files for viewing/extraction.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  preferredAuth: '2lo',
  inputSchema,

  // eslint-disable-next-line @typescript-eslint/require-await
  buildPreview: async (input) => {
    // This tool takes a URN, not a project_id — it has no getProjectId, so
    // wrapMutationTool's allow-list check (which only runs when a project id is
    // present) never fires for it. Enforce fail-closed here instead: while an
    // allow-list is configured, refuse rather than silently bypass it.
    checkUnscopedToolAllowed('md_trigger_translation', 'Model Derivative URN');

    const encoded = encodeMdUrn(input.urn);
    const body = {
      input: { urn: encoded, ...(input.force_regenerate ? { compressedUrn: false } : {}) },
      output: {
        formats: [{ type: 'svf2', views: ['2d', '3d'], advanced: { generateMasterViews: true } }],
      },
    };
    return {
      method: 'POST',
      url: 'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
      body,
      sideEffects: [
        `Submits a new SVF2 translation job for URN: ${input.urn}`,
        `force_regenerate: ${String(input.force_regenerate)}`,
        'No BIM data is modified — only derivative files are produced.',
      ],
      businessRulesPassed: ['translation is a read-only derivative operation'],
      executePayload: { urn: input.urn, forceRegenerate: input.force_regenerate },
    };
  },

  execute: async (input, ctx) => {
    const auth = ctx.auth2lo ?? ctx.auth;
    const job = await triggerMdTranslation(auth, input.urn, input.force_regenerate);
    return {
      content: [
        {
          type: 'text',
          text:
            `Translation job submitted.\n` +
            `Result:  ${job.result}\n` +
            `URN:     ${job.urn}\n\n` +
            `Use md_get_manifest to poll status. SVF2 typically completes in 1–5 minutes.`,
        },
      ],
      structuredContent: { result: job.result, urn: job.urn },
    };
  },
};
