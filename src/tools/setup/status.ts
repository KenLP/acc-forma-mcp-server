import { z } from 'zod';
import type { ReadToolDef, ToolContext } from '../_types.js';
import { listServiceAccounts, SSA_ADMIN_SCOPES } from '../../apis/ssa-admin.js';
import type { ServiceAccountDetails } from '../../apis/ssa-admin.js';
import { ApsApiError } from '../../http/errors.js';
import { clientIdPrefix, readRobotFile } from '../../selfhost/robot-file.js';

/** APS-enforced service accounts per Client ID (see scripts/tenant-admin.ts cmdCreate). */
export const SERVICE_ACCOUNT_QUOTA = 10;

const inputSchema = z.object({});

/** `pending` = not done yet but not a problem (the robot before setup_create_robot runs). */
type Check = { ok: boolean; pending?: boolean; label: string; detail: string };

/**
 * Turns a 2-legged token failure into the setting the user has to change. The provider
 * throws `2-legged token fetch failed (<status>): <body>`; APS puts an OAuth error code
 * (`invalid_client`, `invalid_scope`, ...) in that body.
 */
export function explainTokenError(message: string): string {
  if (/invalid_client|\(401\)/i.test(message)) {
    return 'APS rejected the Client ID / Client Secret pair. Re-copy both from the app page in APS (My Apps) into the extension settings.';
  }
  if (/AUTH-001|does not have access to the api product/i.test(message)) {
    return (
      'APS does not recognize this Client ID, or the app has no API access. Re-copy the Client ID ' +
      'from the app page in APS (My Apps) and check that the app is a Server-to-Server app.'
    );
  }
  if (/invalid_scope|scope/i.test(message)) {
    return (
      'APS refused the service-account management scopes for this app. Check that the app is a ' +
      'Server-to-Server app and that service accounts are enabled for it in APS (My Apps).'
    );
  }
  return `Could not get an APS token: ${message}`;
}

async function checkApsAccess(
  ctx: ToolContext,
): Promise<{ token: Check; accounts?: ServiceAccountDetails[]; quota?: Check }> {
  try {
    await ctx.auth.getAccessToken();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { token: { ok: false, label: 'APS app credentials', detail: explainTokenError(message) } };
  }
  const token: Check = { ok: true, label: 'APS app credentials', detail: 'Client ID and secret accepted.' };

  try {
    const accounts = await listServiceAccounts(ctx.auth);
    const used = accounts.length;
    return {
      token,
      accounts,
      quota: {
        ok: used < SERVICE_ACCOUNT_QUOTA,
        label: 'Service account quota',
        detail:
          used < SERVICE_ACCOUNT_QUOTA
            ? `${used} of ${SERVICE_ACCOUNT_QUOTA} service accounts used on this app.`
            : `All ${SERVICE_ACCOUNT_QUOTA} service accounts on this app are used. Delete an unused one in APS, or request a higher quota through APS "Get Help".`,
      },
    };
  } catch (err) {
    const detail =
      err instanceof ApsApiError && (err.isForbidden() || err.isUnauthorized())
        ? `APS refused to list service accounts (${err.status}). The app needs the service-account management permission — check the app type (Server-to-Server) and its settings in APS (My Apps).`
        : `Listing service accounts failed: ${err instanceof ApsApiError ? err.toMcpText() : String(err)}`;
    return { token, quota: { ok: false, label: 'Service account access', detail } };
  }
}

export const setupStatusTool: ReadToolDef<typeof inputSchema> = {
  name: 'setup_status',
  title: 'BIMLynx Setup Status',
  description:
    'Reports the self-host setup checklist for this BIMLynx install: whether the APS app ' +
    'credentials are accepted, how many of the app\'s service-account slots are used, and ' +
    'whether a robot account has already been created in the data folder. Available only ' +
    'while the server is in setup mode; the robot itself is created by setup_create_robot.',
  kind: 'read',
  scopes: [...SSA_ADMIN_SCOPES],
  // Talks to the APS service-account API of the user's own app — no ACC hub or project.
  scope: { kind: 'no-resource' },
  inputSchema,

  execute: async (_input, ctx) => {
    const dataDir = ctx.env.BIMLYNX_DATA_DIR;
    const checks: Check[] = [];

    checks.push({
      ok: dataDir !== undefined,
      label: 'Data folder',
      detail: dataDir ?? 'BIMLYNX_DATA_DIR is not set.',
    });

    const robot = dataDir !== undefined ? readRobotFile(dataDir, ctx.env.APS_CLIENT_ID) : undefined;
    if (robot?.status === 'ok') {
      checks.push({
        ok: true,
        label: 'Robot account',
        detail: `Already created: ${robot.record.email}. Restart Claude Desktop to load the full tool set.`,
      });
    } else if (robot?.status === 'invalid') {
      checks.push({
        ok: false,
        label: 'Robot account',
        detail: `${robot.reason} Move or delete the data folder's robot.json and robot-key.pem, then run setup again.`,
      });
    } else {
      checks.push({
        ok: false,
        pending: true,
        label: 'Robot account',
        detail: 'Not created yet — setup_create_robot creates it.',
      });
    }

    const aps = await checkApsAccess(ctx);
    checks.push(aps.token);
    if (aps.quota) checks.push(aps.quota);

    const bimlynxRobots = (aps.accounts ?? []).filter((a) => a.name?.startsWith('bimlynx-'));
    const ready = checks.every((c) => c.ok || c.pending === true);
    const lines = [
      `BIMLynx self-host setup — Client ID ${clientIdPrefix(ctx.env.APS_CLIENT_ID)}…`,
      '',
      ...checks.map((c) => `${c.ok ? '[ok]' : c.pending ? '[  ]' : '[--]'} ${c.label}: ${c.detail}`),
    ];
    if (bimlynxRobots.length > 0) {
      lines.push(
        '',
        `Existing BIMLynx robots on this app: ${bimlynxRobots.map((a) => `${a.email} (${a.status})`).join(', ')}`,
      );
    }
    lines.push(
      '',
      robot?.status === 'ok'
        ? 'Setup is complete.'
        : ready
          ? 'Ready to create the robot account.'
          : 'Fix the items marked [--] above before creating the robot account.',
    );

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        dataDir: dataDir ?? null,
        robotStatus: robot?.status ?? 'absent',
        checks,
        readyToCreate: ready && robot?.status !== 'ok' && robot?.status !== 'invalid',
      },
    };
  },
};
