import { describe, it, expect } from 'vitest';
import {
  aecdmPositionToViewer,
  buildPushpin,
  buildRasterPushpin,
  isNormalized,
  DOCS_FILES_PLACEMENT,
  METERS_TO_FEET,
} from '../../../../src/apis/pushpin.js';

describe('aecdmPositionToViewer — coordinate transform', () => {
  it('METERS_TO_FEET is the standard conversion factor', () => {
    expect(METERS_TO_FEET).toBeCloseTo(3.280839895, 6);
  });

  it('scales metres to feet when no offset is given (global coordinates)', () => {
    const viewer = aecdmPositionToViewer({ x: 1, y: 2, z: 3 });
    expect(viewer.x).toBeCloseTo(3.280839895, 6);
    expect(viewer.y).toBeCloseTo(6.56167979, 6);
    expect(viewer.z).toBeCloseTo(9.842519685, 6);
  });

  it('reproduces the issue #24 ground truth (El Cabrillo door) within click tolerance', () => {
    // Same door, matched by External ID 5b72d515-…-0027fac7.
    //   AECDM position (m): (1.1441, -8.5012, 0.0000)
    //   stored pin (viewer): (6.0675, -26.2538, -0.7824)
    //   globalOffset:        (-2.4884681701660156, -1.657135009765625, 5.109887022411177)
    const aecdmMeters = { x: 1.1441, y: -8.5012, z: 0 };
    const globalOffset = {
      x: -2.4884681701660156,
      y: -1.657135009765625,
      z: 5.109887022411177,
    };
    const viewer = aecdmPositionToViewer(aecdmMeters, globalOffset);

    // X/Y match the hand-placed pin to within ~0.18 ft (the human click offset).
    expect(viewer.x).toBeCloseTo(6.0675, 0); // 6.242 vs 6.067 → Δ 0.17 ft
    expect(viewer.y).toBeCloseTo(-26.2538, 1); // -26.234 vs -26.254 → Δ 0.02 ft
    // Z is intentionally not asserted tightly: AECDM gives the floor-level origin
    // (z=0) while the human pinned at door-handle height — a placement choice,
    // not a transform error.
  });

  it('supports a metric (metres) viewer via unitFactor=1', () => {
    const viewer = aecdmPositionToViewer({ x: 5, y: 6, z: 7 }, { x: 0, y: 0, z: 0 }, 1);
    expect(viewer).toEqual({ x: 5, y: 6, z: 7 });
  });

  it('supports a millimetre viewer via unitFactor=1000', () => {
    const viewer = aecdmPositionToViewer({ x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1000);
    expect(viewer.x).toBe(2000);
  });
});

describe('buildPushpin — linkedDocuments assembly', () => {
  it('uses TwoDVectorPushpin + is3D:true (the working 3D pin shape)', () => {
    const pin = buildPushpin({
      lineageUrn: 'urn:adsk.wipprod:dm.lineage:abc',
      viewableGuid: 'guid-123',
      position: { x: 1, y: 2, z: 3 },
      objectId: 867,
      externalId: '55df8d60-74fa-4925-bbf0-72fad4c5d365-0018d796',
      createdAtVersion: 3,
    });

    expect(pin.type).toBe('TwoDVectorPushpin');
    expect(pin.details?.viewable?.is3D).toBe(true);
    expect(pin.details?.viewable?.guid).toBe('guid-123');
    expect(pin.details?.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(pin.details?.objectId).toBe(867);
    expect(pin.details?.externalId).toBe('55df8d60-74fa-4925-bbf0-72fad4c5d365-0018d796');
    expect(pin.urn).toBe('urn:adsk.wipprod:dm.lineage:abc');
    expect(pin.createdAtVersion).toBe(3);
  });

  it('omits optional anchors when not supplied', () => {
    const pin = buildPushpin({
      lineageUrn: 'urn:adsk.wipprod:dm.lineage:abc',
      viewableGuid: 'guid-123',
      position: { x: 0, y: 0, z: 0 },
    });
    expect(pin.details?.objectId).toBeUndefined();
    expect(pin.details?.externalId).toBeUndefined();
    expect(pin.createdAtVersion).toBeUndefined();
  });
});

describe('isNormalized — 2D sheet coordinate guard', () => {
  it('accepts coordinates within [0,1]', () => {
    expect(isNormalized({ x: 0, y: 0 })).toBe(true);
    expect(isNormalized({ x: 1, y: 1 })).toBe(true);
    expect(isNormalized({ x: 0.42, y: 0.73 })).toBe(true);
  });

  it('rejects out-of-range or non-finite coordinates', () => {
    expect(isNormalized({ x: -0.01, y: 0.5 })).toBe(false);
    expect(isNormalized({ x: 0.5, y: 1.5 })).toBe(false);
    expect(isNormalized({ x: 612, y: 792 })).toBe(false); // raw PDF points
    expect(isNormalized({ x: NaN, y: 0 })).toBe(false);
  });
});

describe('buildRasterPushpin — 2D PDF sheet pin assembly', () => {
  it('builds the TwoDRasterPushpin contract proven against issue displayId 1', () => {
    const pin = buildRasterPushpin({
      lineageUrn: 'urn:adsk.wipprod:dm.lineage:pdf1',
      viewableId: 'Layout1',
      position: { x: 0.25, y: 0.6 },
      viewableName: 'Sheet A-101',
      createdAtVersion: 2,
    });

    expect(pin.type).toBe('TwoDRasterPushpin');
    expect(pin.urn).toBe('urn:adsk.wipprod:dm.lineage:pdf1');
    expect(pin.details?.viewable?.viewableId).toBe('Layout1');
    expect(pin.details?.viewable?.is3D).toBe(false);
    expect(pin.details?.viewable?.name).toBe('Sheet A-101');
    // Position is 2D normalized — no z key at all.
    expect(pin.details?.position).toEqual({ x: 0.25, y: 0.6 });
    expect(pin.details?.position).not.toHaveProperty('z');
    // No SVF2 guid leaks onto a raster pin.
    expect(pin.details?.viewable?.guid).toBeUndefined();
    expect(pin.createdAtVersion).toBe(2);
  });

  it('defaults placements to the Docs files origin context', () => {
    const pin = buildRasterPushpin({
      lineageUrn: 'urn:adsk.wipprod:dm.lineage:pdf1',
      viewableId: 'Layout1',
      position: { x: 0.5, y: 0.5 },
    });
    expect(pin.placements).toEqual([{ originContext: { product: 'docs', tool: 'files' } }]);
    expect(DOCS_FILES_PLACEMENT.originContext.product).toBe('docs');
  });

  it('honors caller-supplied placements', () => {
    const placements = [{ originContext: { product: 'docs', tool: 'reviews' } }];
    const pin = buildRasterPushpin({
      lineageUrn: 'urn:adsk.wipprod:dm.lineage:pdf1',
      viewableId: 'Layout1',
      position: { x: 0.5, y: 0.5 },
      placements,
    });
    expect(pin.placements).toEqual(placements);
  });

  it('throws when position is not normalized (raw PDF points)', () => {
    expect(() =>
      buildRasterPushpin({
        lineageUrn: 'urn:adsk.wipprod:dm.lineage:pdf1',
        viewableId: 'Layout1',
        position: { x: 306, y: 396 },
      }),
    ).toThrow(/normalized 0–1/);
  });
});
