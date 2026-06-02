/**
 * Helper: list all AECDM hubs and their projects (raw dump).
 * Use this when find-design-and-rooms.ts says "No project matched" — so you
 * can see the actual project names AECDM exposes to your SSA.
 *
 * Usage:
 *   pnpm exec tsx scripts/list-aecdm-projects.ts
 */
import 'dotenv/config';
import { SsaAuthProvider } from '../src/auth/ssa.js';
import type { AuthProvider } from '../src/auth/index.js';
import { listAecdmHubs, listAecdmProjects } from '../src/apis/aecdm.js';

function makeAuth(): AuthProvider {
  return new SsaAuthProvider(['data:read']);
}

async function main(): Promise<void> {
  const auth = makeAuth();
  const hubs = await listAecdmHubs(auth);
  console.log(`\nFound ${hubs.length} AECDM hub(s)\n`);

  for (const hub of hubs) {
    console.log(`HUB  id=${hub.id}\n     name=${hub.name}`);
    try {
      const projects = await listAecdmProjects(auth, hub.id);
      if (projects.length === 0) {
        console.log('     (no projects visible to this SSA)\n');
        continue;
      }
      console.log(`     ${projects.length} project(s):`);
      for (const p of projects) {
        console.log(`       • ${p.name}`);
        console.log(`         id=${p.id}`);
      }
      console.log();
    } catch (err) {
      console.log(`     ERROR: ${(err as Error).message}\n`);
    }
  }
}

main().catch((err: unknown) => {
  console.error('FAILED:', err);
  process.exit(1);
});
