/**
 * Helper: list ACC hubs and their projects, print as a clean table.
 * Run from repo root:
 *   pnpm exec tsx scripts/list-hubs-and-projects.ts
 */
import 'dotenv/config';
import { SsaAuthProvider } from '../src/auth/ssa.js';
import { TwoLeggedAuthProvider } from '../src/auth/two-legged.js';
import type { AuthProvider } from '../src/auth/index.js';
import { env } from '../src/config/env.js';
import { listHubs, listProjects } from '../src/apis/data-management.js';

function makeAuth(): AuthProvider {
  if (env.APS_AUTH_MODE === 'ssa') {
    return new SsaAuthProvider(['data:read', 'account:read']);
  }
  return new TwoLeggedAuthProvider(['data:read', 'account:read']);
}

async function main(): Promise<void> {
  const auth = makeAuth();
  const hubs = await listHubs(auth);
  console.log(`\nFound ${hubs.length} hub(s)\n`);
  for (const hub of hubs) {
    console.log(`HUB  id=${hub.id}  region=${hub.region}  type=${hub.type}  name=${hub.name}`);
    try {
      const projects = await listProjects(auth, hub.id);
      if (projects.length === 0) {
        console.log('     (no projects)');
      }
      for (const p of projects) {
        console.log(
          `  └─ PROJECT  id=${p.id}  type=${p.type}  status=${p.status ?? '-'}  name=${p.name}`,
        );
      }
    } catch (err) {
      console.log(`     ERROR listing projects: ${(err as Error).message}`);
    }
    console.log();
  }
}

main().catch((err: unknown) => {
  console.error('FAILED:', err);
  process.exit(1);
});
