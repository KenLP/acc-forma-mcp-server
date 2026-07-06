import { describe, it, expect } from 'vitest';
import type { DiffElement } from '../../src/apis/model-properties.js';
import { evaluateRules, groupByDiscipline } from './rules.js';

const roomFunctionChange: DiffElement = {
  kind: 'CHANGED',
  category: 'Rooms',
  name: 'Room 101',
  changes: [{ field: 'Room Name', category: 'Other', prev: 'Meeting Room', cur: 'Office' }],
};
const roomGeomOnlyChange: DiffElement = {
  kind: 'CHANGED',
  category: 'Rooms',
  name: 'Room 102',
  changes: [{ field: 'Area', category: 'Dimensions', prev: 120, cur: 130 }],
};
const wallAdded: DiffElement = { kind: 'ADDED', category: 'Walls', name: 'Basic Wall [1]' };
const columnChanged: DiffElement = { kind: 'CHANGED', category: 'Structural Columns', name: 'Col [2]' };
const doorChanged: DiffElement = { kind: 'CHANGED', category: 'Doors', name: 'Door [3]' };

describe('change-alert rules', () => {
  it('flags a room FUNCTION change (name/department) to Structural', () => {
    const matches = evaluateRules([roomFunctionChange]);
    expect(matches.map((m) => m.rule.id)).toContain('room-function-change');
  });

  it('does NOT flag a room GEOMETRY-only change as a function change', () => {
    const matches = evaluateRules([roomGeomOnlyChange]);
    expect(matches.map((m) => m.rule.id)).not.toContain('room-function-change');
  });

  it('flags added/modified walls and columns to Structural', () => {
    const matches = evaluateRules([wallAdded, columnChanged]);
    const ids = matches.map((m) => m.rule.id);
    expect(ids).toContain('walls-added-or-changed');
    expect(ids).toContain('columns-added-or-changed');
  });

  it('ignores unrelated categories (Doors)', () => {
    expect(evaluateRules([doorChanged])).toHaveLength(0);
  });

  it('groups all matches under the Structural discipline', () => {
    const matches = evaluateRules([roomFunctionChange, wallAdded, columnChanged]);
    const byDiscipline = groupByDiscipline(matches);
    expect([...byDiscipline.keys()]).toEqual(['Structural']);
    expect(byDiscipline.get('Structural')).toHaveLength(3);
  });
});
