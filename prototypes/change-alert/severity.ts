// Impact-triage layer — the differentiator over Forma "Compare Versions".
//
// Forma's Compare tells you WHAT changed ("modified / Geometry", "modified / Attribute")
// and rolls it up by category. It does NOT tell you (a) HOW it changed in plain terms —
// especially for Geometry/Transform — nor (b) whether the change actually MATTERS to a
// downstream discipline. This module answers both:
//
//   • `describeChange()` turns the raw property delta (p-hash key → old/new value) into a
//     human, quantified line — "Start Level Offset: 0 → 7600 (Δ +7600)". That is gap #1
//     Ken identified in the Forma export.
//   • `assess()` classifies each changed element into a severity (CRITICAL…LOW) with a
//     one-line engineering reason, so 200 modified rows collapse to the 3 a Structural
//     engineer must actually look at.
//
// Pure + data-driven → unit-tested in severity.spec.ts. `mp_diff_versions` is the sensor;
// this is the judgment.

import type { DiffElement, PropChange } from '../../src/apis/model-properties.js';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Assessment {
  severity: Severity;
  /** One-line engineering reason — why this change matters (or doesn't). */
  headline: string;
  /** Human, quantified "what changed" — old → new of the meaningful parameters. */
  detail: string;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
};

// ── Category / parameter classifiers ────────────────────────────────────────────
const STRUCTURAL_RE = /joist|column|framing|beam|truss|brace|foundation|footing|structural/i;
const WALL_RE = /wall/i;
const FLOOR_RE = /floor|slab/i;
// Revit reference/vertical params — a change here re-hosts or vertically shifts the member,
// which changes its length, end conditions and load path (not a cosmetic edit).
const VERTICAL_PARAM_RE = /level|elevation|offset|height|reference/i;

// ── "What changed" renderer (gap #1) ────────────────────────────────────────────

/** Trim a number to a compact string: 7600.000000 → "7600", 3.28084 → "3.28". */
function trimNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number(n.toFixed(3)).toString();
}

/** Coerce a prop value to a display string; parse numeric-looking strings so we can Δ them. */
function fmt(v: unknown): string {
  if (typeof v === 'number') return trimNum(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? trimNum(n) : v;
  }
  if (v === null || v === undefined) return '∅';
  return JSON.stringify(v);
}

/** Numeric value of a prop if it is (or parses as) a finite number, else undefined. */
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Render one parameter change as "Field: old → new (Δ +x)". */
export function describeChange(c: PropChange): string {
  let s = `${c.field}: ${fmt(c.prev)} → ${fmt(c.cur)}`;
  const a = num(c.prev);
  const b = num(c.cur);
  if (a !== undefined && b !== undefined && a !== b) {
    const d = b - a;
    s += ` (Δ ${d > 0 ? '+' : ''}${trimNum(d)})`;
  }
  return s;
}

/** Render the whole element's change set (or the change *kind* for add/remove/geometry). */
export function describeElementChange(el: DiffElement): string {
  if (el.kind === 'ADDED') return 'newly added';
  if (el.kind === 'REMOVED') return 'removed';
  if (el.changes && el.changes.length > 0) {
    return el.changes.map(describeChange).join('; ');
  }
  // No property delta available — only the change TYPE is known (Forma stops here too).
  if (el.changeType === 'Transform') return 'moved / rotated (Transform — no property delta exposed)';
  if (el.changeType === 'Geometry') return 'geometry reshaped (Geometry — no property delta exposed)';
  return 'modified (property-only)';
}

// ── Severity classifier (gap: does it MATTER?) ──────────────────────────────────

const mk = (severity: Severity, headline: string) =>
  (el: DiffElement): Assessment => ({ severity, headline, detail: describeElementChange(el) });

/**
 * Classify a single diffed element by its impact on Structural analysis.
 * Reads BOTH the change type (Transform / Geometry / property-only) AND which parameters
 * changed — so a joist whose Reference Level flips is CRITICAL while a wall finish swap is LOW.
 */
export function assess(el: DiffElement): Assessment {
  const cat = el.category ?? '';
  const ct = el.changeType;
  const touchesVertical = (el.changes ?? []).some((c) => VERTICAL_PARAM_RE.test(c.field));

  // Structural members — highest scrutiny.
  if (STRUCTURAL_RE.test(cat)) {
    if (el.kind === 'REMOVED')
      return mk('CRITICAL', 'Structural member removed — load path may be broken; re-check continuity.')(el);
    if (el.kind === 'ADDED')
      return mk('HIGH', 'New structural member — add it to the analysis model.')(el);
    if (ct === 'Transform')
      return mk('CRITICAL', 'Structural member moved — grid/position shift changes tributary area & connections.')(el);
    if (touchesVertical)
      return mk('CRITICAL', 'Structural member re-hosted / vertically shifted — member length & end conditions change.')(el);
    if (ct === 'Geometry')
      return mk('HIGH', 'Structural member geometry changed — re-verify section capacity.')(el);
    return mk('MEDIUM', 'Structural member parameters changed — review.')(el);
  }

  // Walls — bearing walls matter; finish-only edits are noise.
  if (WALL_RE.test(cat)) {
    if (el.kind === 'ADDED')
      return mk('HIGH', 'Wall added — new dead load; verify whether it is load-bearing.')(el);
    if (el.kind === 'REMOVED')
      return mk('HIGH', 'Wall removed — if load-bearing, the load path changes.')(el);
    if (ct === 'Geometry')
      return mk('MEDIUM', 'Wall geometry changed — reshaped/extended; check bearing & openings.')(el);
    if (touchesVertical)
      return mk('MEDIUM', 'Wall vertical extents changed (level/offset).')(el);
    return mk('LOW', 'Wall attribute change (likely finish/type) — low structural impact.')(el);
  }

  // Floors / slabs — diaphragm & load path.
  if (FLOOR_RE.test(cat)) {
    if (el.kind === 'ADDED' || el.kind === 'REMOVED')
      return mk('HIGH', `Floor/slab ${el.kind.toLowerCase()} — diaphragm & load path affected.`)(el);
    if (ct === 'Geometry')
      return mk('HIGH', 'Floor/slab geometry changed — opening or boundary edit affects load path.')(el);
    return mk('MEDIUM', 'Floor/slab parameters changed — review.')(el);
  }

  return mk('LOW', 'Change with low structural impact.')(el);
}

/** Sort helper: highest severity first (stable within a tier). */
export function bySeverityDesc(a: Assessment, b: Assessment): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
}
