import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

const bboxSchema = z.object({ min: vec3Schema, max: vec3Schema });

const elementSchema = z.object({
  objectId: z.number().int(),
  name: z.string(),
  sourceUrn: z.string().optional().describe('Model URN this element came from (informational label).'),
  bbox: bboxSchema,
});

const inputSchema = z.object({
  set_a: z
    .array(elementSchema)
    .min(1)
    .describe(
      'First set of elements with bounding boxes. ' +
        'Use the structuredContent.elements array from md_get_properties for the host model.',
    ),
  set_b: z
    .array(elementSchema)
    .min(1)
    .describe(
      'Second set of elements with bounding boxes (e.g., linked model). ' +
        'Use the structuredContent.elements array from md_get_properties for the linked file.',
    ),
  clearance_threshold: z
    .number()
    .positive()
    .describe(
      'Minimum acceptable distance between element bounding boxes. ' +
        'Pairs with distance < threshold are reported as soft clashes. ' +
        'Unit must match the model coordinates (typically decimal feet for US-imperial Revit, ' +
        'metres for metric). Example: 0.5 for 0.5 ft (~150 mm) clearance in an imperial model.',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('Maximum number of clash pairs to return, sorted by distance ascending.'),
});

// ── Geometry helpers ──────────────────────────────────────────────────────────

interface Vec3 { x: number; y: number; z: number }
interface BBox { min: Vec3; max: Vec3 }

/**
 * Minimum distance between two axis-aligned bounding boxes.
 * Returns 0 when they overlap (hard clash), positive otherwise (soft clash / clear).
 */
function aabbMinDistance(a: BBox, b: BBox): number {
  const gx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const gy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const gz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.sqrt(gx * gx + gy * gy + gz * gz);
}

/** Compute the centre point of a bounding box. */
function bboxCentre(b: BBox): Vec3 {
  return {
    x: (b.min.x + b.max.x) / 2,
    y: (b.min.y + b.max.y) / 2,
    z: (b.min.z + b.max.z) / 2,
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const mdCheckClearanceTool: ReadToolDef<typeof inputSchema> = {
  name: 'md_check_clearance',
  title: 'Check Soft Clash / Clearance Between Element Sets',
  description:
    '**Pure geometric computation** — no API call. Checks minimum clearance between two ' +
    'sets of elements using their axis-aligned bounding boxes (AABBs).\n\n' +
    'Results:\n' +
    '  • **Hard clash** — AABBs overlap (distance = 0)\n' +
    '  • **Soft clash** — AABBs are within `clearance_threshold` distance\n' +
    '  • Pairs sorted by distance ascending (worst first)\n\n' +
    'Typical workflow for host-vs-linked-file clash:\n' +
    '  1. `md_get_properties(urn=host_urn, category_filter="Structural Columns")` → set_a\n' +
    '  2. `md_get_properties(urn=link_urn, category_filter="Mechanical Equipment")` → set_b\n' +
    '  3. `md_check_clearance(set_a, set_b, clearance_threshold=0.5)` → clash report\n\n' +
    '⚠️ **Coordinate system assumption:** both sets must be in the same coordinate system. ' +
    'For Revit host + linked files, this requires **Revit Shared Coordinates** to be set up. ' +
    'Without shared coordinates, distances are meaningless. ' +
    'The tool does NOT apply link instance transforms automatically.',
  kind: 'read',
  scopes: [],
  inputSchema,

  // eslint-disable-next-line @typescript-eslint/require-await
  execute: async (input) => {
    interface ClashPair {
      distance: number;
      severity: 'hard' | 'soft';
      a: { objectId: number; name: string; sourceUrn?: string };
      b: { objectId: number; name: string; sourceUrn?: string };
      centreA: Vec3;
      centreB: Vec3;
    }

    const pairs: ClashPair[] = [];

    for (const ea of input.set_a) {
      for (const eb of input.set_b) {
        const dist = aabbMinDistance(ea.bbox, eb.bbox);
        if (dist < input.clearance_threshold) {
          pairs.push({
            distance: dist,
            severity: dist === 0 ? 'hard' : 'soft',
            a: { objectId: ea.objectId, name: ea.name, ...(ea.sourceUrn !== undefined ? { sourceUrn: ea.sourceUrn } : {}) },
            b: { objectId: eb.objectId, name: eb.name, ...(eb.sourceUrn !== undefined ? { sourceUrn: eb.sourceUrn } : {}) },
            centreA: bboxCentre(ea.bbox),
            centreB: bboxCentre(eb.bbox),
          });
        }
      }
    }

    // Sort by distance ascending (hard clashes first, then closest soft clashes)
    pairs.sort((x, y) => x.distance - y.distance);
    const topPairs = pairs.slice(0, input.max_results);

    const hardCount = pairs.filter((p) => p.severity === 'hard').length;
    const softCount = pairs.filter((p) => p.severity === 'soft').length;

    if (topPairs.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No clashes or clearance violations found.\n` +
              `Checked ${input.set_a.length} × ${input.set_b.length} = ` +
              `${input.set_a.length * input.set_b.length} pairs against threshold ${input.clearance_threshold}.`,
          },
        ],
        structuredContent: { hardClashes: 0, softClashes: 0, pairs: [], totalPairsChecked: input.set_a.length * input.set_b.length },
      };
    }

    const fmt = (n: number): string => n.toFixed(4);

    const lines: string[] = [
      `Found ${pairs.length} violations (${hardCount} hard, ${softCount} soft) — ` +
        `showing top ${topPairs.length}:`,
      '',
    ];

    for (const p of topPairs) {
      const tag = p.severity === 'hard' ? '🔴 HARD' : '🟡 SOFT';
      lines.push(
        `${tag}  distance: ${fmt(p.distance)}  (threshold: ${input.clearance_threshold})`,
        `  A: ${p.a.name} (id: ${p.a.objectId})${p.a.sourceUrn ? `  [${p.a.sourceUrn}]` : ''}`,
        `  B: ${p.b.name} (id: ${p.b.objectId})${p.b.sourceUrn ? `  [${p.b.sourceUrn}]` : ''}`,
        '',
      );
    }

    if (pairs.length > input.max_results) {
      lines.push(`…and ${pairs.length - input.max_results} more (increase max_results to see all)`);
    }

    lines.push(
      '',
      `Checked ${input.set_a.length} × ${input.set_b.length} = ${input.set_a.length * input.set_b.length} pairs.`,
    );

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        hardClashes: hardCount,
        softClashes: softCount,
        totalViolations: pairs.length,
        totalPairsChecked: input.set_a.length * input.set_b.length,
        pairs: topPairs,
      },
    };
  },
};
