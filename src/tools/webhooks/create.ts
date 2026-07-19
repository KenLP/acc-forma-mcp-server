import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import {
  createHook,
  systemForEvent,
  DM_EVENTS,
  ISSUE_EVENTS,
} from '../../apis/webhooks.js';
import {
  assertValidCallbackUrl,
  parseCallbackHostAllowlist,
} from '../../safety/callback-url.js';

const ALL_EVENTS = [...DM_EVENTS, ...ISSUE_EVENTS] as const;

const inputSchema = z.object({
  event: z
    .enum(ALL_EVENTS)
    .describe(
      'Event to subscribe to. Data Management events (dm.*) are scoped to a folder URN; ' +
        'Issues events are scoped to a project id and carry a mandatory "-1.0" version suffix.',
    ),
  callback_url: z
    .string()
    .min(1)
    .describe(
      'Public https endpoint Autodesk will POST each event to. It must answer 2xx within ' +
        '6 seconds or the delivery counts as failed. Loopback and private addresses are refused.',
    ),
  scope_value: z
    .string()
    .min(1)
    .describe(
      'Folder URN ("urn:adsk.wipprod:fs.folder:co...", from dm_list_top_folders or ' +
        'dm_list_folder_contents) for dm.* events, or an ACC project id for issue.* events. ' +
        'A hook on a project\'s root folder also covers every subfolder.',
    ),
  filter: z
    .string()
    .optional()
    .describe(
      'Optional JSONPath filter evaluated against the event payload, e.g. ' +
        '"$[?(@.ext==\'rvt\')]" to fire only for Revit files.',
    ),
  hook_attribute: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional JSON (under 1 KB) echoed back in every callback. Commonly used to carry the ' +
        'project id, which Data Management payloads do not otherwise include.',
    ),
  auto_reactivate: z
    .boolean()
    .default(false)
    .describe(
      'When true, Autodesk retries a hook it deactivated after 7 days instead of leaving it ' +
        'permanently dead. Default false, matching the API default.',
    ),
});

export const webhooksCreateTool: MutationToolDef<typeof inputSchema> = {
  name: 'webhooks_create',
  title: 'Create Webhook',
  description:
    'Webhooks API mutation — registers a hook so Autodesk POSTs an event payload to a ' +
    'callback URL whenever the subscribed event occurs on the given folder or project. ' +
    'This configures ongoing egress: once created, project event data (file names, folder ' +
    'URNs, issue contents) flows to the callback endpoint until the hook is deleted, with ' +
    'no further call from this server. Hooks are region-partitioned and are created under ' +
    'the server\'s configured APS_REGION. A duplicate callback URL for the same event and ' +
    'scope is rejected by Autodesk with 409. Auth: 2-legged.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  preferredAuth: '2lo',
  // A dm.* hook is scoped to a folder URN, which cannot be mapped back to a DM project id
  // — the same limitation that makes md_* and aecdm_* unmappable. Declaring the whole tool
  // unmappable (rather than 'dm', which would be true only for issue.* events) keeps the
  // allow-list promise honest: while it is active this tool is refused outright.
  scope: { kind: 'unmappable', resource: 'webhook scope (folder URN or project id)' },
  inputSchema,

  // Issue hooks are scoped by project id, so the audit entry and rate counter can be
  // attributed. Folder-scoped hooks have no project id to attribute them to.
  getProjectId: (i) =>
    systemForEvent(i.event).scopeKey === 'project' ? i.scope_value : undefined,

  // eslint-disable-next-line @typescript-eslint/require-await
  buildPreview: async (input, ctx) => {
    const { system, scopeKey } = systemForEvent(input.event);
    const url = assertValidCallbackUrl(
      input.callback_url,
      parseCallbackHostAllowlist(ctx.env.FORMA_ALLOWED_CALLBACK_HOSTS),
    );

    const body: Record<string, unknown> = {
      callbackUrl: input.callback_url,
      scope: { [scopeKey]: input.scope_value },
    };
    if (input.hook_attribute) body['hookAttribute'] = input.hook_attribute;
    if (input.filter) body['filter'] = input.filter;
    if (input.auto_reactivate) body['autoReactivateHook'] = true;

    const dataDescription =
      scopeKey === 'folder'
        ? 'file and folder metadata (names, extensions, URNs, sizes, the acting user)'
        : 'issue contents (title, description, status, assignee, custom attributes)';

    return {
      method: 'POST',
      url:
        `https://developer.api.autodesk.com/webhooks/v1/systems/${system}` +
        `/events/${encodeURIComponent(input.event)}/hooks`,
      body,
      sideEffects: [
        `ONGOING EGRESS: from now until this hook is deleted, Autodesk will POST ${dataDescription} to ${url.origin} every time "${input.event}" fires on ${scopeKey} ${input.scope_value}.`,
        `The receiving host is ${url.hostname}. Verify you control it — this server cannot revoke delivery once the hook exists, only delete the hook.`,
        `Created in region ${ctx.env.APS_REGION}; it will be invisible to calls made under any other region.`,
        input.filter
          ? `Only events matching the JSONPath filter ${input.filter} are delivered.`
          : 'No filter: every occurrence of this event in scope is delivered.',
        input.auto_reactivate
          ? 'auto_reactivate=true: Autodesk will retry the hook 7 days after deactivating it.'
          : 'auto_reactivate=false: after 5 consecutive delivery failures the hook goes inactive and stays that way.',
      ],
      businessRulesPassed: [
        `callback URL is https and publicly routable (${url.hostname})`,
        ctx.env.FORMA_ALLOWED_CALLBACK_HOSTS === '*'
          ? 'FORMA_ALLOWED_CALLBACK_HOSTS is unrestricted (*) — any public host is permitted'
          : `callback host is in FORMA_ALLOWED_CALLBACK_HOSTS`,
        `event "${input.event}" maps to system "${system}" with ${scopeKey} scope`,
      ],
      executePayload: {
        event: input.event,
        callbackUrl: input.callback_url,
        scopeValue: input.scope_value,
        filter: input.filter,
        hookAttribute: input.hook_attribute,
        autoReactivate: input.auto_reactivate,
      },
    };
  },

  execute: async (input, ctx) => {
    // Re-validate on the execute path: the approval token binds the payload, but the host
    // allow-list is server config and this keeps enforcement independent of the token.
    assertValidCallbackUrl(
      input.callback_url,
      parseCallbackHostAllowlist(ctx.env.FORMA_ALLOWED_CALLBACK_HOSTS),
    );

    const created = await createHook(ctx.auth, {
      event: input.event,
      callbackUrl: input.callback_url,
      scopeValue: input.scope_value,
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
      ...(input.hook_attribute !== undefined ? { hookAttribute: input.hook_attribute } : {}),
      autoReactivateHook: input.auto_reactivate,
    });

    const idLine =
      created.hookId !== undefined
        ? `hookId:  ${created.hookId}`
        : `hookId:  could not be parsed from the Location header (${created.location ?? 'header absent'}). ` +
          `The hook was created — find it with webhooks_list.`;

    return {
      content: [
        {
          type: 'text',
          text:
            `Webhook created.\n` +
            `${idLine}\n` +
            `event:   ${created.event}\n` +
            `scope:   ${created.scopeKey}=${created.scopeValue}\n` +
            `region:  ${ctx.env.APS_REGION}\n` +
            `callback: ${created.callbackUrl}\n\n` +
            `Delivery starts immediately. The endpoint must answer 2xx within 6 seconds; ` +
            `verify the x-adsk-signature header (HMAC-SHA1 over the raw body) before trusting a payload. ` +
            `Remove with webhooks_delete using this hookId and event.`,
        },
      ],
      structuredContent: {
        hookId: created.hookId ?? null,
        event: created.event,
        system: created.system,
        scope: { [created.scopeKey]: created.scopeValue },
        callbackUrl: created.callbackUrl,
        region: ctx.env.APS_REGION,
      },
    };
  },
};
