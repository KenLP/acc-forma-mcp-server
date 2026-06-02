/**
 * Smoke test: call `queryElementPositions` directly against the live AECDM API.
 *
 * No MCP client, no transport — just runs the API function and prints results.
 * Useful for verifying:
 *   1. The new `geometryDataByElements` GraphQL call works on your hub.
 *   2. The transform decoder produces sensible coordinates.
 *   3. How many elements in the category have geometry data.
 *
 * Usage:
 *   pnpm exec tsx scripts/smoke-element-positions.ts <elementGroupId> <category> [maxElements]
 *
 * Example:
 *   pnpm exec tsx scripts/smoke-element-positions.ts "$DEMO_ELEMENT_GROUP_ID" Rooms 20
 *
 * Requires .env with SSA_* creds.
 *
 * KNOWN LIMITATION (2026-06):
 *   AECDM `geometryDataByElements` is Public Beta. On some hubs the call
 *   chain (including `elementsByElementGroup`) returns
 *   "GraphQL error: You do not have access to resource." even with a valid
 *   SSA that succeeds against the same elementGroupId via the hierarchy
 *   walker (`scripts/find-design-and-rooms.ts`). Suspected cause: Beta
 *   feature flag gating or per-session permission propagation on Autodesk's
 *   side. Until Autodesk stabilises the geometry endpoints, the tool may
 *   not work end-to-end on every hub. The unit tests cover the code paths;
 *   re-run this smoke once Autodesk announces GA.
 */
import 'dotenv/config';
import { SsaAuthProvider } from '../src/auth/ssa.js';
import type { AuthProvider } from '../src/auth/index.js';
import { queryElementPositions } from '../src/apis/aecdm.js';

function makeAuth(): AuthProvider {
  return new SsaAuthProvider(['data:read']);
}

async function main(): Promise<void> {
  const [elementGroupId, category, maxArg] = process.argv.slice(2);
  if (!elementGroupId || !category) {
    console.error(
      'Usage: tsx scripts/smoke-element-positions.ts <elementGroupId> <category> [maxElements]',
    );
    process.exit(2);
  }
  const maxElements = maxArg ? Number(maxArg) : 50;

  const auth = makeAuth();

  console.log(
    `\nFetching up to ${maxElements} elements in "${category}" from element group:\n  ${elementGroupId}\n`,
  );

  const t0 = Date.now();
  const positions = await queryElementPositions(auth, elementGroupId, category, {
    maxElements,
    batchSize: 50,
  });
  const ms = Date.now() - t0;

  const withPos = positions.filter((p) => p.position !== null).length;
  const withoutPos = positions.length - withPos;

  console.log(`Done in ${ms}ms.`);
  console.log(`  Total elements:     ${positions.length}`);
  console.log(`  With position:      ${withPos}`);
  console.log(`  Without position:   ${withoutPos}\n`);

  for (const el of positions.slice(0, 10)) {
    if (!el.position) {
      console.log(`  • ${el.name}  (id=${el.id.slice(0, 24)}…)  [no geometry data]`);
    } else {
      const { x, y, z } = el.position;
      console.log(
        `  • ${el.name}  (id=${el.id.slice(0, 24)}…)  → (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})`,
      );
    }
  }
  if (positions.length > 10) console.log(`  …and ${positions.length - 10} more`);

  if (withPos === 0 && positions.length > 0) {
    console.log(
      '\n⚠ No element returned a decodable position. Either geometryDataByElements is not\n' +
        '  available on this hub, or Transform.value uses a layout the decoder does not\n' +
        '  recognise yet. Run scripts/introspect-aecdm-schema.ts to inspect the schema.',
    );
  }
}

main().catch((err: unknown) => {
  console.error('FAILED:', err);
  process.exit(1);
});
