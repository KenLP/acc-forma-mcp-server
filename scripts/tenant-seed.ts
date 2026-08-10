/**
 * Tenant seed CLI — provision / list / disable remote-mode tenants (Robot-per-Tenant SSA,
 * see docs/specs/SPEC_remote-mcp.md §2-3, R1 item 2).
 *
 * Usage (via the package.json `tenant` script, or directly with tsx):
 *
 *   npm run tenant -- create --name "Acme Corp" \
 *     --robot-email robot@acme.autodesk.com --service-account-id <SSA id> \
 *     --key-id <SSA key id> --key-path ./robot-private-key.pem
 *   npm run tenant -- list
 *   npm run tenant -- disable <tenantId>
 *
 *   npx tsx scripts/tenant-seed.ts create --name "Acme Corp" \
 *     --robot-email robot@acme.autodesk.com --service-account-id <SSA id> \
 *     --key-id <SSA key id> --key-path ./robot-private-key.pem
 *   npx tsx scripts/tenant-seed.ts list
 *   npx tsx scripts/tenant-seed.ts disable <tenantId>
 *
 * Requires FORMA_MASTER_KEY (64 hex chars) and APS_CLIENT_ID / APS_CLIENT_SECRET (the
 * publisher's own app credentials, shared across all tenants) in the environment — the
 * same .env the remote server itself uses. Robot creation (the SSA account + key pair
 * itself) is done separately via the APS SSA API (Task 1) — this CLI only stores the
 * result and hands back a bearer key; see R2a for a wrapping admin client.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { env } from '../src/config/env.js';
import { createTenant, listTenants, disableTenant } from '../src/tenancy/index.js';

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    flags.set(key, value);
    i++;
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw new Error(`missing required --${key}`);
  return value;
}

function cmdCreate(argv: string[]): void {
  const flags = parseFlags(argv);
  const name = requireFlag(flags, 'name');
  const robotEmail = requireFlag(flags, 'robot-email');
  const serviceAccountId = requireFlag(flags, 'service-account-id');
  const keyId = requireFlag(flags, 'key-id');
  const keyPath = requireFlag(flags, 'key-path');
  const privateKeyPem = readFileSync(keyPath, 'utf-8');

  const { tenant, bearerKey } = createTenant(
    { name, robotEmail, serviceAccountId, keyId, privateKeyPem },
    env,
  );

  console.log('Tenant created.\n');
  console.log(`  id:          ${tenant.id}`);
  console.log(`  name:        ${tenant.name}`);
  console.log(`  robot email: ${tenant.robotEmail}`);
  console.log('\n  bearer key (shown once — copy it now, it cannot be recovered later):');
  console.log(`  ${bearerKey}\n`);
  console.log('Two things the customer admin must do (SSA Task 2 — no dev skills needed):');
  console.log(
    `  1. Add Client ID ${env.APS_CLIENT_ID} to Custom Integrations in the ACC/Forma admin console.`,
  );
  console.log(
    `  2. Invite ${tenant.robotEmail} as a member with the products this tenant needs to use.`,
  );
}

function cmdList(): void {
  const tenants = listTenants();
  if (tenants.length === 0) {
    console.log('No tenants.');
    return;
  }
  for (const t of tenants) {
    const status = t.disabled ? '[disabled]' : '[active]  ';
    console.log(`${t.id}  ${status}  ${t.name}  <${t.robotEmail}>  created ${t.createdAt}`);
  }
}

function cmdDisable(argv: string[]): void {
  const id = argv[0];
  if (!id) throw new Error('usage: tenant-seed disable <tenantId>');
  disableTenant(id);
  console.log(`Tenant ${id} disabled.`);
}

function main(): void {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'create':
      cmdCreate(rest);
      break;
    case 'list':
      cmdList();
      break;
    case 'disable':
      cmdDisable(rest);
      break;
    default:
      console.error('Usage: tenant-seed <create|list|disable> [options]');
      process.exit(1);
  }
}

main();
