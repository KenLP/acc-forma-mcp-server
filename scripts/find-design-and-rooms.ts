/**
 * Helper: walk AECDM hierarchy to find the elementGroupId for a Revit file
 * and count Rooms — confirms MVP scenario data is available.
 *
 * AECDM IDs are urn:adsk:* — different from DM IDs (b.uuid). This script
 * resolves DM→AECDM by matching project names.
 *
 * Usage:
 *   pnpm exec tsx scripts/find-design-and-rooms.ts \
 *     <projectNameSubstring> <fileNameSubstring>
 *
 * Example:
 *   pnpm exec tsx scripts/find-design-and-rooms.ts "MCP Testing" "Pacific Continental"
 */
import 'dotenv/config';
import { SsaAuthProvider } from '../src/auth/ssa.js';
import type { AuthProvider } from '../src/auth/index.js';
import {
  listAecdmHubs,
  listAecdmProjects,
  listAecdmElementGroups,
  queryElementsByCategory,
} from '../src/apis/aecdm.js';

function makeAuth(): AuthProvider {
  return new SsaAuthProvider(['data:read']);
}

async function main(): Promise<void> {
  const [projectNeedleArg, fileNeedleArg] = process.argv.slice(2);
  if (!projectNeedleArg || !fileNeedleArg) {
    console.error(
      'Usage: tsx scripts/find-design-and-rooms.ts <projectNameSubstring> <fileNameSubstring>',
    );
    process.exit(2);
  }
  const projectNeedle = projectNeedleArg.toLowerCase();
  const fileNeedle = fileNeedleArg.toLowerCase();

  const auth = makeAuth();

  console.log('\nStep 1: listing AECDM hubs ...');
  const hubs = await listAecdmHubs(auth);
  console.log(`  Found ${hubs.length} hub(s).`);

  for (const hub of hubs) {
    console.log(`\nStep 2: listing AECDM projects in hub ${hub.id} (${hub.name}) ...`);
    const projects = await listAecdmProjects(auth, hub.id);
    const matchedProjects = projects.filter((p) =>
      p.name?.toLowerCase().includes(projectNeedle),
    );
    if (matchedProjects.length === 0) {
      console.log(`  No project matched '${projectNeedleArg}'.`);
      continue;
    }

    for (const project of matchedProjects) {
      console.log(`\nMATCH project  aecdmProjectId=${project.id}`);
      console.log(`                name=${project.name}`);

      console.log('\nStep 3: listing element groups (BIM models in this project) ...');
      const groups = await listAecdmElementGroups(auth, project.id);
      console.log(`  Found ${groups.length} element group(s).`);

      const matchedGroups = groups.filter((g) =>
        g.name?.toLowerCase().includes(fileNeedle),
      );
      if (matchedGroups.length === 0) {
        console.log('\n  No element group matched. Showing all groups:');
        for (const g of groups) {
          console.log(`    - ${g.name}`);
        }
        continue;
      }

      for (const g of matchedGroups) {
        console.log(`\n  MATCH design  elementGroupId=${g.id}`);
        console.log(`                 name=${g.name}`);
        try {
          const rooms = await queryElementsByCategory(auth, g.id, 'Rooms', 200);
          console.log(`                 Rooms count: ${rooms.length}`);
          const sample = rooms.slice(0, 10);
          for (const r of sample) {
            const get = (n: string): unknown =>
              r.properties?.find((p) => p.name === n)?.value;
            const name = get('Name') ?? '(no Name)';
            const number = get('Number') ?? '(no Number)';
            const dept = get('Department') ?? '(EMPTY)';
            const occ =
              (get('Occupancy') as string | undefined) ??
              (get('OccupancyType') as string | undefined) ??
              '(EMPTY)';
            const area = get('Area') ?? '(no Area)';
            console.log(
              `                   • #${number} | "${name}" | Dept=${dept} | Occ=${occ} | Area=${area}`,
            );
          }
          if (rooms.length > 10) {
            console.log(`                   ... and ${rooms.length - 10} more`);
          }
        } catch (err) {
          console.log(`                 ERROR querying rooms: ${(err as Error).message}`);
        }
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error('FAILED:', err);
  process.exit(1);
});
