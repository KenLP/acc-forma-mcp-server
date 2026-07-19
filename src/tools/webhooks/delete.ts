import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { deleteHook, systemForEvent, DM_EVENTS, ISSUE_EVENTS } from '../../apis/webhooks.js';

const ALL_EVENTS = [...DM_EVENTS, ...ISSUE_EVENTS] as const;

const inputSchema = z.object({
  event: z
    .enum(ALL_EVENTS)
    .describe(
      'The event the hook is registered for. Required — the delete endpoint is addressed by ' +
        'system and event, not by hookId alone. Read it from webhooks_list.',
    ),
  hook_id: z.string().min(1).describe('hookId from webhooks_list or webhooks_create.'),
});

export const webhooksDeleteTool: MutationToolDef<typeof inputSchema> = {
  name: 'webhooks_delete',
  title: 'Delete Webhook',
  description:
    'Webhooks API mutation — removes a hook, stopping all further event delivery to its ' +
    'callback URL. This is the only way to end the egress a hook configures. Deletion is ' +
    'permanent: the hook cannot be restored, only recreated. Operates on the server\'s ' +
    'configured APS_REGION, so a hook created under a different region is not addressable ' +
    'here. Auth: 2-legged.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  preferredAuth: '2lo',
  // Addressed by hookId, which carries no hub or project id — nothing to check an
  // allow-list against. Same treatment as webhooks_create and the md_* tools.
  scope: { kind: 'unmappable', resource: 'webhook id' },
  inputSchema,

  // eslint-disable-next-line @typescript-eslint/require-await
  buildPreview: async (input, ctx) => {
    const { system } = systemForEvent(input.event);
    return {
      method: 'DELETE',
      url:
        `https://developer.api.autodesk.com/webhooks/v1/systems/${system}` +
        `/events/${encodeURIComponent(input.event)}/hooks/${encodeURIComponent(input.hook_id)}`,
      body: null,
      sideEffects: [
        `Stops all event delivery for hook ${input.hook_id} ("${input.event}"). Any downstream automation fed by this hook goes silent.`,
        'Permanent — the hook cannot be restored, only recreated with webhooks_create (which yields a new hookId).',
        `Addressed in region ${ctx.env.APS_REGION}; a hook created under a different region will return 404 here.`,
      ],
      businessRulesPassed: [`event "${input.event}" maps to system "${system}"`],
      executePayload: { event: input.event, hookId: input.hook_id },
    };
  },

  execute: async (input, ctx) => {
    await deleteHook(ctx.auth, input.event, input.hook_id);
    return {
      content: [
        {
          type: 'text',
          text:
            `Webhook deleted.\n` +
            `hookId: ${input.hook_id}\n` +
            `event:  ${input.event}\n` +
            `region: ${ctx.env.APS_REGION}\n\n` +
            `No further callbacks will be delivered for this hook.`,
        },
      ],
      structuredContent: {
        deleted: true,
        hookId: input.hook_id,
        event: input.event,
        region: ctx.env.APS_REGION,
      },
    };
  },
};
