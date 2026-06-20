import { describe, it, expect } from 'vitest';
import { resolveClashes } from '../../../../src/apis/model-coordination.js';

// Real shapes observed from the live clash resource files (Plumbing × Architectural test).
const clashes = [
  { id: 1732440314666, clash: [1428, 3358] as [number, number], dist: -0.0510198117085601, status: 1 },
  { id: 8579498710554, clash: [1428, 3346] as [number, number], dist: -0.0537555032209127, status: 1 },
  { id: 15193261680238, clash: [2741, 7088] as [number, number], dist: -0.0261747496381233, status: 1 },
  { id: 99, clash: [10, 20] as [number, number], dist: 0.5, status: 2 }, // a gap, different status
];
const instances = [
  { cid: 1732440314666, ldid: 1, loid: 1428, lvid: 5444, rdid: 0, roid: 3358, rvid: 9741 },
  { cid: 8579498710554, ldid: 1, loid: 1428, lvid: 5444, rdid: 0, roid: 3346, rvid: 9715 },
  { cid: 15193261680238, ldid: 0, loid: 2741, lvid: 6001, rdid: 1, roid: 7088, rvid: 8002 },
  { cid: 99, ldid: 0, loid: 10, lvid: 11, rdid: 1, roid: 20, rvid: 21 },
];
const documents = [
  { id: 1, urn: 'urn:adsk.wipprod:fs.file:vf.mMOB5AnzRTO6kouVvXmlRw?version=4', viewableName: '{3D}' },
  { id: 0, urn: 'urn:adsk.wipprod:fs.file:vf.zxhzGseAS7yHZSRRho0H1A?version=4', viewableName: '3D Plumbing' },
];

describe('resolveClashes — join clash/instance/document', () => {
  it('resolves element identity and document URNs, sorted by penetration (worst first)', () => {
    const out = resolveClashes(clashes, instances, documents);
    expect(out).toHaveLength(4);
    // Most-negative distance first
    expect(out[0]!.clashId).toBe(8579498710554); // dist -0.0537
    expect(out[0]!.distance).toBeCloseTo(-0.0537555, 6);
    // left = ldid 1 = Architectural {3D}, right = rdid 0 = Plumbing
    expect(out[0]!.left.viewableName).toBe('{3D}');
    expect(out[0]!.left.objectId).toBe(1428);
    expect(out[0]!.left.lmvId).toBe(5444);
    expect(out[0]!.right.viewableName).toBe('3D Plumbing');
    expect(out[0]!.right.objectId).toBe(3346);
    expect(out[0]!.right.documentUrn).toContain('zxhzGse');
    // The positive-gap clash sorts last
    expect(out[out.length - 1]!.clashId).toBe(99);
  });

  it('filters by raw status code', () => {
    const out = resolveClashes(clashes, instances, documents, { status: 1 });
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.status === 1)).toBe(true);
  });

  it('filters by minimum penetration magnitude', () => {
    const out = resolveClashes(clashes, instances, documents, { minPenetration: 0.05 });
    // Only the two clashes with |dist| ≥ 0.05 (the gap 0.5 also passes |0.5|≥0.05)
    expect(out.map((c) => c.clashId).sort()).toEqual([99, 1732440314666, 8579498710554].sort());
  });

  it('caps results with maxResults', () => {
    const out = resolveClashes(clashes, instances, documents, { maxResults: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.clashId).toBe(8579498710554); // worst kept
  });

  it('skips clashes with no matching instance (cannot resolve identity)', () => {
    const out = resolveClashes(
      [{ id: 7, clash: [1, 2], dist: -0.1, status: 1 }],
      [], // no instances
      documents,
    );
    expect(out).toHaveLength(0);
  });
});
