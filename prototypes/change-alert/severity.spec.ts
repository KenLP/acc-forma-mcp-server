import { describe, it, expect } from 'vitest';
import type { DiffElement } from '../../src/apis/model-properties.js';
import { assess, describeChange, describeElementChange, bySeverityDesc } from './severity.js';

// Mirrors the real Forma Compare export Ken shared: a K-Series bar joist re-hosted to a
// new reference level with a 7600 mm level offset.
const joistLevelChange: DiffElement = {
  kind: 'CHANGED',
  category: 'Structural Framing',
  name: 'M_K-Series Bar Joist-Angle Web',
  changeType: 'Unknown',
  changes: [
    { field: 'Reference Level', category: 'Constraints', prev: '00 - Ground', cur: '01 - Entry Level' },
    { field: 'Start Level Offset', category: 'Constraints', prev: 0, cur: 7600 },
    { field: 'End Level Offset', category: 'Constraints', prev: 0, cur: 7600 },
  ],
};
const columnMoved: DiffElement = {
  kind: 'CHANGED', category: 'Structural Columns', name: 'Col C-4', changeType: 'Transform',
};
const columnRemoved: DiffElement = { kind: 'REMOVED', category: 'Structural Columns', name: 'Col B-2' };
const wallGeom: DiffElement = { kind: 'CHANGED', category: 'Walls', name: 'Basic Wall', changeType: 'Geometry' };
const wallAdded: DiffElement = { kind: 'ADDED', category: 'Walls', name: 'Basic Wall' };
const wallFinish: DiffElement = {
  kind: 'CHANGED', category: 'Walls', name: 'Basic Wall', changeType: 'Unknown',
  changes: [{ field: 'Structural Material', category: 'Materials', prev: 'Paint A', cur: 'Paint B' }],
};
const floorGeom: DiffElement = { kind: 'CHANGED', category: 'Floors', name: 'Floor', changeType: 'Geometry' };
const doorMoved: DiffElement = { kind: 'CHANGED', category: 'Doors', name: 'M_Single-Flush', changeType: 'Transform' };

describe('impact triage — severity', () => {
  it('flags a joist re-hosted to a new level (vertical param change) as CRITICAL', () => {
    expect(assess(joistLevelChange).severity).toBe('CRITICAL');
  });

  it('flags a moved structural column (Transform) as CRITICAL', () => {
    expect(assess(columnMoved).severity).toBe('CRITICAL');
  });

  it('flags a removed structural column as CRITICAL (broken load path)', () => {
    expect(assess(columnRemoved).severity).toBe('CRITICAL');
  });

  it('rates a wall geometry change MEDIUM and an added wall HIGH', () => {
    expect(assess(wallGeom).severity).toBe('MEDIUM');
    expect(assess(wallAdded).severity).toBe('HIGH');
  });

  it('treats a wall finish/material-only attribute change as LOW noise', () => {
    expect(assess(wallFinish).severity).toBe('LOW');
  });

  it('rates a floor geometry change HIGH (load path / opening)', () => {
    expect(assess(floorGeom).severity).toBe('HIGH');
  });

  it('rates a moved door LOW for the Structural discipline', () => {
    expect(assess(doorMoved).severity).toBe('LOW');
  });
});

describe('what-changed renderer (gap #1 — Forma shows only "Geometry"/"Attribute")', () => {
  it('quantifies a numeric parameter change with a delta', () => {
    expect(describeChange({ field: 'Start Level Offset', category: 'C', prev: 0, cur: 7600 })).toBe(
      'Start Level Offset: 0 → 7600 (Δ +7600)',
    );
  });

  it('renders a text parameter change without a delta', () => {
    expect(describeChange({ field: 'Reference Level', category: 'C', prev: '00 - Ground', cur: '01 - Entry Level' })).toBe(
      'Reference Level: 00 - Ground → 01 - Entry Level',
    );
  });

  it('names the change type when no property delta is exposed (Geometry/Transform)', () => {
    expect(describeElementChange(wallGeom)).toMatch(/geometry reshaped/i);
    expect(describeElementChange(columnMoved)).toMatch(/moved \/ rotated/i);
  });

  it('joins multiple parameter changes for one element', () => {
    expect(describeElementChange(joistLevelChange)).toContain('Reference Level:');
    expect(describeElementChange(joistLevelChange)).toContain('Start Level Offset: 0 → 7600 (Δ +7600)');
  });
});

describe('severity ordering', () => {
  it('sorts CRITICAL before HIGH before MEDIUM before LOW', () => {
    const sorted = [wallFinish, columnMoved, wallGeom, wallAdded].map(assess).sort(bySeverityDesc);
    expect(sorted.map((a) => a.severity)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  });
});
