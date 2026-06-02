/**
 * Helper: introspect the AECDM GraphQL schema and probe candidate field paths
 * that might expose element bounding boxes or spatial extents.
 *
 * Background: `aecdm_query_element_bboxes` originally queried a speculative
 * `geometry { boundingBox { min/max x/y/z } }` selection on `Element` — but
 * the live AECDM schema rejects this with "Cannot query field 'geometry' on
 * type 'Element'". This script lets you verify what's *actually* on the
 * `Element` type for your hub, and probes the candidate field names so we
 * can wire whichever one works back into the tool.
 *
 * Usage:
 *   pnpm exec tsx scripts/introspect-aecdm-schema.ts <elementGroupId> <category>
 *
 * Example:
 *   pnpm exec tsx scripts/introspect-aecdm-schema.ts \
 *     "$DEMO_ELEMENT_GROUP_ID" "Rooms"
 *
 * Requires .env with SSA_* creds (same as scripts/find-design-and-rooms.ts).
 *
 * Output:
 *   1) `__type(name: "Element")` introspection — every field + return type.
 *   2) A checklist of candidate spatial fields, each marked ✓ (server accepts)
 *      or ✗ (with the GraphQL error message).
 *
 * Paste the output back so we know which path to wire in.
 */
import 'dotenv/config';
import { SsaAuthProvider } from '../src/auth/ssa.js';
import type { AuthProvider } from '../src/auth/index.js';
import { apsGraphQL } from '../src/http/client.js';

function makeAuth(): AuthProvider {
  return new SsaAuthProvider(['data:read']);
}

// ---- 1) Introspection of the Element type ---------------------------------

interface IntrospectFieldType {
  kind: string;
  name: string | null;
  ofType?: IntrospectFieldType | null;
}

interface IntrospectField {
  name: string;
  description: string | null;
  type: IntrospectFieldType;
}

interface IntrospectTypeResponse {
  __type: {
    name: string;
    kind: string;
    description: string | null;
    fields: IntrospectField[] | null;
  } | null;
}

const INTROSPECT_TYPE_QUERY = /* GraphQL */ `
  query IntrospectType($name: String!) {
    __type(name: $name) {
      name
      kind
      description
      fields {
        name
        description
        type {
          kind
          name
          ofType {
            kind
            name
            ofType { kind name }
          }
        }
      }
    }
  }
`;

function renderType(t: IntrospectFieldType): string {
  if (t.kind === 'NON_NULL' && t.ofType) return `${renderType(t.ofType)}!`;
  if (t.kind === 'LIST' && t.ofType) return `[${renderType(t.ofType)}]`;
  return t.name ?? '?';
}

async function introspectType(auth: AuthProvider, typeName: string): Promise<void> {
  console.log(`\n=== Introspection: type "${typeName}" ===`);
  try {
    const data = await apsGraphQL<IntrospectTypeResponse>(auth, INTROSPECT_TYPE_QUERY, {
      name: typeName,
    });
    if (!data.__type) {
      console.log(`  Type "${typeName}" not found in schema.`);
      return;
    }
    console.log(`  kind=${data.__type.kind}`);
    if (data.__type.description) console.log(`  description: ${data.__type.description}`);
    const fields = data.__type.fields ?? [];
    console.log(`  fields (${fields.length}):`);
    for (const f of fields) {
      const desc = f.description ? `  — ${f.description.split('\n')[0]}` : '';
      console.log(`    • ${f.name}: ${renderType(f.type)}${desc}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}`);
  }
}

// ---- 2) Probe candidate field paths on a real Element ---------------------

interface ProbeCase {
  label: string;
  /**
   * GraphQL selection inside the element node (everything between `id name` and the closing brace).
   */
  selection: string;
}

const PROBES: ProbeCase[] = [
  // Direct spatial fields candidates
  { label: 'geometry { boundingBox { min { x y z } max { x y z } } }', selection: 'geometry { boundingBox { min { x y z } max { x y z } } }' },
  { label: 'boundingBox { min { x y z } max { x y z } }', selection: 'boundingBox { min { x y z } max { x y z } }' },
  { label: 'bbox { min { x y z } max { x y z } }', selection: 'bbox { min { x y z } max { x y z } }' },
  { label: 'extent { min { x y z } max { x y z } }', selection: 'extent { min { x y z } max { x y z } }' },
  { label: 'location { x y z }', selection: 'location { x y z }' },
  { label: 'position { x y z }', selection: 'position { x y z }' },
  { label: 'centroid { x y z }', selection: 'centroid { x y z }' },

  // Property-based candidates
  { label: 'propertyByName(name: "BoundingBox") { name value }', selection: 'propertyByName(name: "BoundingBox") { name value }' },
  { label: 'propertyByName(name: "Bounding Box") { name value }', selection: 'propertyByName(name: "Bounding Box") { name value }' },
  { label: 'propertyByName(name: "Location") { name value }', selection: 'propertyByName(name: "Location") { name value }' },
  { label: 'propertyByName(name: "Element Location") { name value }', selection: 'propertyByName(name: "Element Location") { name value }' },
  { label: 'propertyByName(name: "Center") { name value }', selection: 'propertyByName(name: "Center") { name value }' },
  { label: 'propertyByName(name: "Origin") { name value }', selection: 'propertyByName(name: "Origin") { name value }' },
];

function buildProbeQuery(selection: string): string {
  return /* GraphQL */ `
    query ProbeElementField(
      $elementGroupId: ID!
      $filter: String!
      $limit: Int
    ) {
      elementsByElementGroup(
        elementGroupId: $elementGroupId
        filter: { query: $filter }
        pagination: { limit: $limit }
      ) {
        results {
          id
          name
          ${selection}
        }
      }
    }
  `;
}

async function probeField(
  auth: AuthProvider,
  elementGroupId: string,
  category: string,
  probe: ProbeCase,
): Promise<{ ok: boolean; detail: string }> {
  const query = buildProbeQuery(probe.selection);
  try {
    const data = await apsGraphQL<{
      elementsByElementGroup: { results: Array<Record<string, unknown>> };
    }>(auth, query, {
      elementGroupId,
      filter: `property.name.category=='${category}'`,
      limit: 1,
    });
    const results = data.elementsByElementGroup.results ?? [];
    if (results.length === 0) {
      return { ok: true, detail: '(no rows returned — field accepted by schema; cannot verify shape)' };
    }
    const sample = results[0];
    // Drop id/name to focus on the probed selection
    const { id: _id, name: _name, ...rest } = sample as { id?: string; name?: string; [k: string]: unknown };
    void _id;
    void _name;
    const json = JSON.stringify(rest);
    return { ok: true, detail: json.length > 200 ? `${json.slice(0, 200)}…` : json };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.replace(/\s+/g, ' ').trim() };
  }
}

// ---- main -----------------------------------------------------------------

async function main(): Promise<void> {
  const [elementGroupId, category] = process.argv.slice(2);
  if (!elementGroupId || !category) {
    console.error('Usage: tsx scripts/introspect-aecdm-schema.ts <elementGroupId> <category>');
    process.exit(2);
  }

  const auth = makeAuth();

  // Step 1: introspect the canonical Element type
  await introspectType(auth, 'Element');

  // Also peek at related types if present — useful when bbox lives under a wrapper type
  for (const t of ['Geometry', 'BoundingBox', 'Property', 'PropertyCollection', 'Vec3', 'Vector3']) {
    await introspectType(auth, t);
  }

  // Step 2: probe candidate field paths on a real element
  console.log(`\n=== Probes against elementGroupId=${elementGroupId} category="${category}" ===`);
  console.log('(✓ = server accepted the selection; ✗ = GraphQL validation/runtime error)\n');

  for (const probe of PROBES) {
    const { ok, detail } = await probeField(auth, elementGroupId, category, probe);
    const marker = ok ? '✓' : '✗';
    console.log(`  ${marker} ${probe.label}`);
    console.log(`      → ${detail}`);
  }

  console.log('\nDone. Share the ✓/✗ list back to wire the working field into queryElementPositions().');
}

main().catch((err: unknown) => {
  console.error('FAILED:', err);
  process.exit(1);
});
