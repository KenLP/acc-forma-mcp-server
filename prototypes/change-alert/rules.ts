// Change-alert rule table — maps a diffed element to the discipline(s) that must react.
//
// This is the POLICY layer of the change-alerting prototype: `mp_diff_versions` is the
// sensor (what changed), these rules are the routing (who cares). Keep them pure and
// data-driven so they are trivial to unit-test and extend.

import type { DiffElement } from '../../src/apis/model-properties.js';

export interface AlertRule {
  id: string;
  /** Human explanation attached to the alert. */
  reason: string;
  /** Discipline(s) to notify when this rule matches. */
  disciplines: string[];
  /** Predicate over a single diffed element. */
  match: (el: DiffElement) => boolean;
}

/** Room parameters that express a room's *function* (not just its geometry). */
const ROOM_FUNCTION_FIELDS = /^(Room Name|Department|Occupancy)$/i;

/**
 * Prototype rule set (per Ken's spec):
 *   • a Room's function changes (meeting room → office)      → alert Structural
 *   • a wall is added / modified                             → alert Structural
 *   • a column is added / modified                           → alert Structural
 */
export const RULES: AlertRule[] = [
  {
    id: 'room-function-change',
    reason: 'Room function changed (Room Name / Department / Occupancy) — re-evaluate live/dead loads for the affected space.',
    disciplines: ['Structural'],
    match: (el) =>
      el.category === 'Rooms' &&
      el.kind === 'CHANGED' &&
      !!el.changes?.some((c) => ROOM_FUNCTION_FIELDS.test(c.field)),
  },
  {
    id: 'walls-added-or-changed',
    reason: 'Walls added or modified — recompute structural loads and verify support/bracing.',
    disciplines: ['Structural'],
    match: (el) => el.category === 'Walls' && (el.kind === 'ADDED' || el.kind === 'CHANGED'),
  },
  {
    id: 'columns-added-or-changed',
    reason: 'Columns added or modified — verify structural framing and load path.',
    disciplines: ['Structural'],
    match: (el) => /column/i.test(el.category ?? '') && (el.kind === 'ADDED' || el.kind === 'CHANGED'),
  },
];

export interface RuleMatch {
  rule: AlertRule;
  elements: DiffElement[];
}

/** Run every rule over the diffed elements; keep only rules that matched something. */
export function evaluateRules(elements: DiffElement[], rules: AlertRule[] = RULES): RuleMatch[] {
  return rules
    .map((rule) => ({ rule, elements: elements.filter((el) => rule.match(el)) }))
    .filter((m) => m.elements.length > 0);
}

/** Fan rule matches out to the discipline(s) each targets → one bucket per discipline. */
export function groupByDiscipline(matches: RuleMatch[]): Map<string, RuleMatch[]> {
  const out = new Map<string, RuleMatch[]>();
  for (const match of matches) {
    for (const d of match.rule.disciplines) {
      const arr = out.get(d) ?? [];
      arr.push(match);
      out.set(d, arr);
    }
  }
  return out;
}
