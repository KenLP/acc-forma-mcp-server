import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The self-host robot record: what `setup_create_robot` writes into BIMLYNX_DATA_DIR so the
 * next startup can authenticate as that robot without any SSA_* env vars.
 *
 * Two files, both owner-only (0600 on POSIX; on Windows they inherit the folder's ACL, which
 * under the user's profile is already per-user):
 *   - `robot.json`    — identifiers only, safe to show to the user
 *   - `robot-key.pem` — the RS256 private key, returned exactly once by APS
 */

export const ROBOT_FILE = 'robot.json';
export const ROBOT_KEY_FILE = 'robot-key.pem';

export interface RobotRecord {
  serviceAccountId: string;
  /** Robot email — what the ACC admin invites as a project member. */
  email: string;
  keyId: string;
  createdAt: string;
  /**
   * First characters of the Client ID the robot was created under. A robot only
   * authenticates with the app that owns it, so a folder reused after switching apps is
   * reported as a mismatch instead of surfacing later as an opaque 401.
   */
  clientIdPrefix: string;
}

export type RobotFileState =
  | { status: 'absent' }
  | { status: 'ok'; record: RobotRecord; keyPath: string }
  | { status: 'invalid'; reason: string };

const CLIENT_ID_PREFIX_LENGTH = 8;

export function clientIdPrefix(clientId: string): string {
  return clientId.slice(0, CLIENT_ID_PREFIX_LENGTH);
}

function isRobotRecord(value: unknown): value is RobotRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (['serviceAccountId', 'email', 'keyId', 'createdAt', 'clientIdPrefix'] as const).every(
    (k) => typeof v[k] === 'string' && v[k] !== '',
  );
}

/**
 * Reads the robot record from `dataDir`. Never throws: a missing folder or file is
 * `absent`, anything unusable is `invalid` with a reason the user can act on.
 */
export function readRobotFile(dataDir: string, clientId: string): RobotFileState {
  const recordPath = join(dataDir, ROBOT_FILE);
  if (!existsSync(recordPath)) return { status: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf-8'));
  } catch (err) {
    return {
      status: 'invalid',
      reason: `${recordPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (!isRobotRecord(parsed)) {
    return { status: 'invalid', reason: `${recordPath} is missing required fields.` };
  }

  if (parsed.clientIdPrefix !== clientIdPrefix(clientId)) {
    return {
      status: 'invalid',
      reason:
        `${recordPath} belongs to a different APS app (Client ID ${parsed.clientIdPrefix}…), ` +
        `not the configured one (${clientIdPrefix(clientId)}…). A robot only works with the app ` +
        'that created it.',
    };
  }

  const keyPath = join(dataDir, ROBOT_KEY_FILE);
  if (!existsSync(keyPath)) {
    return { status: 'invalid', reason: `${recordPath} exists but its private key ${keyPath} is missing.` };
  }

  return { status: 'ok', record: parsed, keyPath };
}

/**
 * Writes the key first, then the record — `robot.json` is the marker every reader checks,
 * so a crash between the two leaves no record pointing at a missing key. `wx` refuses to
 * overwrite either file: an existing robot is never silently replaced.
 */
export function writeRobotFiles(dataDir: string, record: RobotRecord, privateKeyPem: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, ROBOT_KEY_FILE), privateKeyPem, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(dataDir, ROBOT_FILE), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}
