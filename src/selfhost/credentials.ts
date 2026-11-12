import { readRobotFile } from './robot-file.js';

/**
 * Where the stdio server's SSA robot credentials come from (SPEC_self-host-installer §2.1).
 *
 *   (1) SSA_ID / SSA_KEY_ID / SSA_KEY_PATH env vars      — the original path, always wins
 *   (2) <BIMLYNX_DATA_DIR>/robot.json + robot-key.pem    — written by setup_create_robot
 *   (3) neither                                          — setup mode (only setup tools)
 *
 * (1) must behave exactly as before this module existed: every existing consumer (local
 * dev, bim-orchestrator, ClashDetection, the SEA exe) configures SSA through env vars. A
 * partial set of SSA_* vars is still rejected by config/env.ts, never treated as "absent".
 * Setup mode is only reachable when BIMLYNX_DATA_DIR is set — without it there is nowhere
 * to write a robot, and config/env.ts keeps throwing the original error.
 */

export interface CredentialEnv {
  APS_CLIENT_ID: string;
  SSA_ID?: string | undefined;
  SSA_KEY_ID?: string | undefined;
  SSA_KEY_PATH?: string | undefined;
  BIMLYNX_DATA_DIR?: string | undefined;
}

export type SsaCredentialSource =
  | { source: 'env' }
  | {
      source: 'robot-file';
      dataDir: string;
      ssaId: string;
      ssaKeyId: string;
      ssaKeyPath: string;
      email: string;
    }
  | {
      source: 'setup';
      dataDir: string;
      /** Set when a robot.json exists but cannot be used — shown by setup_status. */
      problem?: string;
    };

export function resolveSsaCredentials(env: CredentialEnv): SsaCredentialSource {
  if (env.SSA_ID || env.SSA_KEY_ID || env.SSA_KEY_PATH) return { source: 'env' };

  const dataDir = env.BIMLYNX_DATA_DIR;
  if (!dataDir) {
    // config/env.ts rejects this combination before we get here; guard anyway so a future
    // caller cannot silently start without credentials.
    throw new Error('No SSA credentials: set SSA_ID/SSA_KEY_ID/SSA_KEY_PATH or BIMLYNX_DATA_DIR.');
  }

  const state = readRobotFile(dataDir, env.APS_CLIENT_ID);
  switch (state.status) {
    case 'ok':
      return {
        source: 'robot-file',
        dataDir,
        ssaId: state.record.serviceAccountId,
        ssaKeyId: state.record.keyId,
        ssaKeyPath: state.keyPath,
        email: state.record.email,
      };
    case 'absent':
      return { source: 'setup', dataDir };
    case 'invalid':
      return { source: 'setup', dataDir, problem: state.reason };
  }
}
