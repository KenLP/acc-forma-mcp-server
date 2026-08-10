/**
 * Tenant admin CLI — full-automation provisioning (SSA management API, see
 * docs/specs/SPEC_remote-mcp.md R2a). Unlike `tenant-seed.ts` (which stores a service
 * account + key you already created by hand, or via the APS console), this CLI creates and
 * manages the service account itself through the SSA management API
 * (`src/apis/ssa-admin.ts`). Keep both scripts — `tenant-seed.ts` is still the path for a
 * pre-existing SSA.
 *
 * Usage:
 *
 *   npx tsx scripts/tenant-admin.ts create --name "Acme Corp"
 *   npx tsx scripts/tenant-admin.ts list-ssa
 *   npx tsx scripts/tenant-admin.ts disable <tenantId>
 *   npx tsx scripts/tenant-admin.ts delete-ssa <serviceAccountId> --yes
 *
 * Requires FORMA_MASTER_KEY, APS_CLIENT_ID, APS_CLIENT_SECRET in the environment — the
 * publisher's own app credentials, used to call the SSA management API as a 2-legged client
 * (NOT a tenant robot's own credential; this CLI manages the whole fleet of robots).
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import { TwoLeggedAuthProvider } from '../src/auth/two-legged.js';
import {
  SSA_ADMIN_SCOPES,
  toServiceAccountName,
  createServiceAccount,
  listServiceAccounts,
  setServiceAccountStatus,
  deleteServiceAccount,
  createServiceAccountKey,
} from '../src/apis/ssa-admin.js';
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

function buildAuth(): TwoLeggedAuthProvider {
  return new TwoLeggedAuthProvider([...SSA_ADMIN_SCOPES], {
    clientId: env.APS_CLIENT_ID,
    clientSecret: env.APS_CLIENT_SECRET,
  });
}

async function cmdCreate(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const rawName = requireFlag(flags, 'name');
  const slug = toServiceAccountName(rawName);

  const auth = buildAuth();

  const existing = await listServiceAccounts(auth);
  if (existing.length >= 10) {
    throw new Error(
      `quota 10 SA/Client ID đã đạt (${existing.length} SA hiện có trên Client ID ${env.APS_CLIENT_ID}) — dùng "Get Help" trên Autodesk Platform Services để xin tăng quota.`,
    );
  }

  const created = await createServiceAccount(auth, {
    name: slug,
    firstName: slug,
    lastName: 'robot',
  });
  console.log(`Service account created: ${created.serviceAccountId} <${created.email}>`);

  let privateKeyPem: string;
  let kid: string;
  try {
    const key = await createServiceAccountKey(auth, created.serviceAccountId);
    privateKeyPem = key.privateKey;
    kid = key.kid;
  } catch (err) {
    console.error(
      `Tạo key cho service account thất bại SAU KHI service account đã được tạo trên APS.\n` +
        `Dọn tay: serviceAccountId=${created.serviceAccountId} (không tự động xoá để tránh xoá nhầm).\n` +
        `Lỗi: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  let tenant;
  let bearerKey: string;
  try {
    const result = createTenant(
      {
        name: rawName,
        robotEmail: created.email,
        serviceAccountId: created.serviceAccountId,
        keyId: kid,
        privateKeyPem,
      },
      env,
    );
    tenant = result.tenant;
    bearerKey = result.bearerKey;
  } catch (err) {
    console.error(
      `createTenant thất bại SAU KHI service account + key đã được tạo trên APS.\n` +
        `Dọn tay: serviceAccountId=${created.serviceAccountId}, keyId=${kid} (không tự động xoá để tránh xoá nhầm).\n` +
        `Lỗi: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  console.log('\nTenant created.\n');
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

async function cmdListSsa(): Promise<void> {
  const auth = buildAuth();
  const remoteAccounts = await listServiceAccounts(auth);
  const localTenants = listTenants();
  const localBySaId = new Map(localTenants.map((t) => [t.serviceAccountId, t]));

  if (remoteAccounts.length === 0) {
    console.log('No service accounts on this Client ID.');
    return;
  }

  for (const sa of remoteAccounts) {
    const tenant = localBySaId.get(sa.serviceAccountId);
    const tenantCol = tenant
      ? `tenant=${tenant.id} (${tenant.disabled ? 'disabled' : 'active'})`
      : 'tenant=(none locally)';
    console.log(
      `${sa.serviceAccountId}  status=${sa.status}  createdAt=${sa.createdAt ?? '-'}  email=${sa.email}  ${tenantCol}`,
    );
  }
}

async function cmdDisable(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) throw new Error('usage: tenant-admin disable <tenantId>');

  const tenant = listTenants().find((t) => t.id === id);
  if (!tenant) throw new Error(`disable: no tenant with id ${id}`);

  // Cut the bearer key off locally first — that is the immediate, verified revoke.
  disableTenant(id);
  console.log(`Tenant ${id} disabled locally — its bearer key is rejected from now on.`);

  const auth = buildAuth();
  await setServiceAccountStatus(auth, tenant.serviceAccountId, 'DISABLED');
  console.log(`Service account ${tenant.serviceAccountId} set to DISABLED on APS.`);
  console.log(
    'Note: new SSA token assertions will now be rejected, but a token already issued may ' +
      'remain valid for up to ~1h — immediate token revocation is not verified.',
  );
}

async function cmdDeleteSsa(argv: string[]): Promise<void> {
  const hasYes = argv.includes('--yes');
  const serviceAccountId = argv.find((a) => a !== '--yes');
  if (!serviceAccountId) {
    throw new Error('usage: tenant-admin delete-ssa <serviceAccountId> --yes');
  }
  if (!hasYes) {
    throw new Error('delete-ssa is destructive — pass --yes to confirm.');
  }

  const auth = buildAuth();
  await deleteServiceAccount(auth, serviceAccountId);
  console.log(`Service account ${serviceAccountId} deleted (and all of its keys with it).`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'create':
      await cmdCreate(rest);
      break;
    case 'list-ssa':
      await cmdListSsa();
      break;
    case 'disable':
      await cmdDisable(rest);
      break;
    case 'delete-ssa':
      await cmdDeleteSsa(rest);
      break;
    default:
      console.error('Usage: tenant-admin <create|list-ssa|disable|delete-ssa> [options]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
