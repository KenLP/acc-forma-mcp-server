import { z } from 'zod';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MutationToolDef, ToolContext } from '../_types.js';
import {
  createServiceAccount,
  createServiceAccountKey,
  listServiceAccounts,
  SSA_ADMIN_SCOPES,
  toServiceAccountName,
} from '../../apis/ssa-admin.js';
import type { CreateServiceAccountInput } from '../../apis/ssa-admin.js';
import { BusinessRuleError } from '../../safety/business-rules.js';
import {
  clientIdPrefix,
  readRobotFile,
  ROBOT_FILE,
  ROBOT_KEY_FILE,
  writeRobotFiles,
} from '../../selfhost/robot-file.js';
import { SERVICE_ACCOUNT_QUOTA } from './status.js';

const inputSchema = z.object({
  robot_name: z
    .string()
    .max(80)
    .optional()
    .describe(
      'Optional label for the robot account (letters, digits and dashes are kept). ' +
        'Defaults to this computer\'s name. The account is always prefixed "bimlynx-".',
    ),
});

interface RobotPayload {
  account: CreateServiceAccountInput;
  dataDir: string;
}

function requireDataDir(ctx: ToolContext): string {
  const dataDir = ctx.env.BIMLYNX_DATA_DIR;
  if (dataDir === undefined) {
    throw new BusinessRuleError('data_folder_set', 'BIMLYNX_DATA_DIR is not set — there is nowhere to store the robot.');
  }
  return dataDir;
}

/**
 * Refuses when the folder already holds a robot (valid or not) or a key without its record.
 * One robot per folder: pressing setup twice must not spend a second of the app's 10
 * service-account slots.
 */
function assertNoRobotYet(dataDir: string, clientId: string): void {
  const state = readRobotFile(dataDir, clientId);
  if (state.status === 'ok') {
    throw new BusinessRuleError(
      'single_robot',
      `a robot already exists in ${dataDir} (${state.record.email}). Restart Claude Desktop to use it. ` +
        `To create a new one, delete ${ROBOT_FILE} and ${ROBOT_KEY_FILE} from that folder first.`,
    );
  }
  if (state.status === 'invalid') {
    throw new BusinessRuleError(
      'single_robot',
      `${state.reason} Move or delete ${ROBOT_FILE} and ${ROBOT_KEY_FILE} from ${dataDir} before creating a new robot.`,
    );
  }
  if (existsSync(join(dataDir, ROBOT_KEY_FILE))) {
    throw new BusinessRuleError(
      'single_robot',
      `${join(dataDir, ROBOT_KEY_FILE)} exists without ${ROBOT_FILE} (an interrupted setup?). Delete it, then run setup again.`,
    );
  }
}

export function robotAccountInput(label: string | undefined): CreateServiceAccountInput {
  // macOS reports the Bonjour name ("Studio-MacBook-Air.local"); the ".local" suffix is not
  // part of the computer's name and would otherwise end up in the robot's ("…-air-local").
  const raw = label !== undefined && label.trim() !== '' ? label : hostname().replace(/\.local$/i, '');
  const name = toServiceAccountName(`bimlynx-${raw}`);
  return { name, firstName: name, lastName: 'robot' };
}

export const setupCreateRobotTool: MutationToolDef<typeof inputSchema, RobotPayload> = {
  name: 'setup_create_robot',
  title: 'Create BIMLynx Robot Account',
  description:
    'Creates the robot (APS Secure Service Account) this BIMLynx install acts as, under the ' +
    'user\'s own APS app, and stores its key in the data folder on this computer. The key is ' +
    'written only to that folder and never appears in tool output or logs. The result names ' +
    'the robot\'s email, which an ACC admin invites to projects. Refused when the data folder ' +
    'already holds a robot. Available only while the server is in setup mode.',
  kind: 'mutation',
  scopes: [...SSA_ADMIN_SCOPES],
  scope: { kind: 'no-resource' },
  inputSchema,

  buildPreview: async (input, ctx) => {
    const dataDir = requireDataDir(ctx);
    assertNoRobotYet(dataDir, ctx.env.APS_CLIENT_ID);

    const existing = await listServiceAccounts(ctx.auth);
    if (existing.length >= SERVICE_ACCOUNT_QUOTA) {
      throw new BusinessRuleError(
        'service_account_quota',
        `all ${SERVICE_ACCOUNT_QUOTA} service accounts on this app are used. Delete an unused one in APS, or request a higher quota through APS "Get Help".`,
      );
    }

    const account = robotAccountInput(input.robot_name);
    if (existing.some((a) => a.name === account.name)) {
      throw new BusinessRuleError(
        'unique_robot_name',
        `a service account named "${account.name}" already exists on this app. Pass a different robot_name.`,
      );
    }

    return {
      method: 'POST',
      url: '/authentication/v2/service-accounts',
      body: account,
      sideEffects: [
        `Creates service account "${account.name}" under Client ID ${clientIdPrefix(ctx.env.APS_CLIENT_ID)}… (uses ${existing.length + 1} of ${SERVICE_ACCOUNT_QUOTA} slots).`,
        'Creates one RSA key pair for it (APS returns the private key once).',
        `Writes ${join(dataDir, ROBOT_KEY_FILE)} (private key, owner-only) and ${join(dataDir, ROBOT_FILE)}.`,
      ],
      businessRulesPassed: ['single_robot', 'service_account_quota', 'unique_robot_name'],
      executePayload: { account, dataDir },
    };
  },

  execute: async (input, ctx, approvedPayload) => {
    const { account, dataDir } = approvedPayload ?? {
      account: robotAccountInput(input.robot_name),
      dataDir: requireDataDir(ctx),
    };
    // Re-checked here: another call may have created the robot since the preview.
    assertNoRobotYet(dataDir, ctx.env.APS_CLIENT_ID);

    const created = await createServiceAccount(ctx.auth, account);

    let key;
    try {
      key = await createServiceAccountKey(ctx.auth, created.serviceAccountId);
    } catch (err) {
      // Not deleted automatically — same policy as tenant-admin create.
      throw new Error(
        `The service account was created (${created.serviceAccountId}, ${created.email}) but creating its key failed: ` +
          `${err instanceof Error ? err.message : String(err)}. Delete that service account in APS, then run setup again.`,
      );
    }

    try {
      writeRobotFiles(
        dataDir,
        {
          serviceAccountId: created.serviceAccountId,
          email: created.email,
          keyId: key.kid,
          createdAt: new Date().toISOString(),
          clientIdPrefix: clientIdPrefix(ctx.env.APS_CLIENT_ID),
        },
        key.privateKey,
      );
    } catch (err) {
      // APS never returns the private key again, so this robot is unusable now.
      throw new Error(
        `The service account was created (${created.serviceAccountId}, ${created.email}) but saving its key to ${dataDir} failed: ` +
          `${err instanceof Error ? err.message : String(err)}. Delete that service account in APS, check the folder is writable, then run setup again.`,
      );
    }

    const text = [
      `Robot account created: ${created.email}`,
      '',
      `Saved to ${dataDir}. Keep that folder private — it holds the robot's key.`,
      '',
      'Next steps:',
      '1. Fully quit and reopen Claude Desktop so BIMLynx loads its full tool set.',
      '2. An ACC account admin adds this app\'s Client ID under Account Admin → Custom Integrations.',
      `3. A project admin invites ${created.email} as a project member (Docs; add Model Coordination for clash tools).`,
    ].join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        serviceAccountId: created.serviceAccountId,
        robotEmail: created.email,
        keyId: key.kid,
        dataDir,
        restartRequired: true,
      },
    };
  },
};
