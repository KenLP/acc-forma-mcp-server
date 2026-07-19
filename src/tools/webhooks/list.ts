import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { listAppHooks } from '../../apis/webhooks.js';

const inputSchema = z.object({
  status: z
    .enum(['active', 'inactive'])
    .optional()
    .describe(
      'Filter by delivery status. `inactive` surfaces hooks Autodesk stopped delivering to ' +
        'after 5 consecutive failed events.',
    ),
  page_state: z
    .string()
    .optional()
    .describe('Cursor from a previous call\'s `next` value. Omit for the first page.'),
});

export const webhooksListTool: ReadToolDef<typeof inputSchema> = {
  name: 'webhooks_list',
  title: 'List Webhooks',
  description:
    'Webhooks API — lists the hooks this application has registered, across Data Management ' +
    '(file/folder events) and ACC Issues. Each entry carries its hookId, event, delivery ' +
    'status, callback URL and scope. Hooks are partitioned by region: this returns only ' +
    'those created under the server\'s configured APS_REGION, so a hook created under a ' +
    'different region will be absent rather than reported as an error. Auth: 2-legged ' +
    '(the endpoint is defined for client-credentials tokens).',
  kind: 'read',
  scopes: ['data:read'],
  preferredAuth: '2lo',
  // Hooks are keyed by folder URN (Data Management) or project id (Issues), and the folder
  // URN cannot be mapped back to a DM project — the same limitation as md_* and aecdm_*.
  // Listing would also disclose which folders across the account carry hooks, so while an
  // allow-list is active this is refused rather than answered unchecked.
  scope: { kind: 'unmappable', resource: 'webhook registry (folder URNs across the account)' },
  inputSchema,

  execute: async (input, ctx) => {
    const { hooks, next } = await listAppHooks(ctx.auth, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.page_state !== undefined ? { pageState: input.page_state } : {}),
    });

    if (hooks.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No webhooks registered in region ${ctx.env.APS_REGION}.\n\n` +
              `If you expected hooks here, check that they were created under the same region — ` +
              `a hook created under a different APS_REGION is not visible to this call.`,
          },
        ],
        structuredContent: { hooks: [], region: ctx.env.APS_REGION },
      };
    }

    const lines = hooks.map((h) => {
      const scopeEntries = Object.entries(h.scope ?? {});
      const scopeText = scopeEntries.length > 0
        ? scopeEntries.map(([k, v]) => `${k}=${v}`).join(', ')
        : 'unscoped';
      const flags = [h.status ?? 'unknown status'];
      if (h.autoReactivateHook) flags.push('auto-reactivate');
      return (
        `• ${h.event}  (${flags.join(', ')})\n` +
        `  hookId:   ${h.hookId}\n` +
        `  scope:    ${scopeText}\n` +
        `  callback: ${h.callbackUrl}`
      );
    });

    const inactive = hooks.filter((h) => h.status === 'inactive').length;
    const footer = [
      inactive > 0
        ? `\n\n${inactive} hook(s) are inactive — Autodesk stopped delivering after repeated ` +
          `callback failures. Recreate them, or create with auto_reactivate=true.`
        : '',
      next ? `\n\nMore results: re-call with page_state="${next}".` : '',
    ].join('');

    return {
      content: [
        {
          type: 'text',
          text: `${hooks.length} webhook(s) in region ${ctx.env.APS_REGION}:\n\n${lines.join('\n\n')}${footer}`,
        },
      ],
      structuredContent: {
        hooks,
        region: ctx.env.APS_REGION,
        ...(next !== undefined ? { next } : {}),
      },
    };
  },
};
