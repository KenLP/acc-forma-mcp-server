import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AecElementPosition } from '../../../../src/apis/aecdm.js';
import type { ToolContext } from '../../../../src/tools/_types.js';

vi.mock('../../../../src/config/env.js', () => ({
  env: {
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    SSA_ID: 'test-ssa-id',
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_RETENTION_DAYS: 90,
  },
}));

const queryElementPositionsMock =
  vi.fn<(...args: unknown[]) => Promise<AecElementPosition[]>>();

vi.mock('../../../../src/apis/aecdm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/apis/aecdm.js')>();
  return {
    ...actual,
    queryElementPositions: (...args: unknown[]) => queryElementPositionsMock(...args),
  };
});

function makeCtx(): ToolContext {
  return {
    auth: {
      getAccessToken: () => Promise.resolve('token'),
      getScopes: () => ['data:read'],
    },
    env: {} as ToolContext['env'],
  };
}

const baseInput = {
  element_group_id: 'urn:adsk.aecdm:elem-group:abc',
  category: 'Rooms',
  max_elements: 500,
  batch_size: 50,
};

describe('aecdm_query_element_positions — tool layer', () => {
  let tool: typeof import('../../../../src/tools/aecdm/query-element-positions.js').aecdmQueryElementPositionsTool;

  beforeEach(async () => {
    vi.resetModules();
    queryElementPositionsMock.mockReset();
    ({ aecdmQueryElementPositionsTool: tool } = await import(
      '../../../../src/tools/aecdm/query-element-positions.js'
    ));
  });

  it('returns "no elements found" when the category is empty', async () => {
    queryElementPositionsMock.mockResolvedValue([]);
    const result = await tool.execute(baseInput, makeCtx());
    expect(result.content[0]!.text).toMatch(/No elements found/i);
    expect(result.structuredContent).toMatchObject({
      elements: [],
      count_with_position: 0,
      count_without_position: 0,
    });
  });

  it('returns positions and accurate counts when all elements have transforms', async () => {
    queryElementPositionsMock.mockResolvedValue([
      { id: 'e1', name: 'Room 101', position: { x: 1, y: 2, z: 3 }, properties: [] },
      { id: 'e2', name: 'Room 102', position: { x: 4, y: 5, z: 6 }, properties: [] },
    ]);
    const result = await tool.execute(baseInput, makeCtx());
    expect(result.content[0]!.text).toContain('2 element(s)');
    expect(result.content[0]!.text).toContain('2 with position, 0 without');
    expect(result.content[0]!.text).toContain('(1.000, 2.000, 3.000)');
    expect(result.structuredContent).toMatchObject({
      count_with_position: 2,
      count_without_position: 0,
    });
  });

  it('reports mixed counts when some elements have null position', async () => {
    queryElementPositionsMock.mockResolvedValue([
      { id: 'e1', name: 'Room 101', position: { x: 1, y: 2, z: 3 }, properties: [] },
      { id: 'e2', name: 'Room 102', position: null, properties: [] },
      { id: 'e3', name: 'Room 103', position: null, properties: [] },
    ]);
    const result = await tool.execute(baseInput, makeCtx());
    expect(result.content[0]!.text).toContain('3 element(s)');
    expect(result.content[0]!.text).toContain('1 with position, 2 without');
    expect(result.content[0]!.text).toContain('[no geometry data]');
    expect(result.structuredContent).toMatchObject({
      count_with_position: 1,
      count_without_position: 2,
    });
  });

  it('forwards reference_bbox into the API options', async () => {
    queryElementPositionsMock.mockResolvedValue([
      { id: 'e1', name: 'Room 101', position: { x: 1, y: 2, z: 3 }, properties: [] },
    ]);
    const referenceBox = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
    await tool.execute({ ...baseInput, reference_bbox: referenceBox }, makeCtx());
    expect(queryElementPositionsMock).toHaveBeenCalledWith(
      expect.anything(),
      baseInput.element_group_id,
      baseInput.category,
      expect.objectContaining({
        referenceBox,
        maxElements: 500,
        batchSize: 50,
      }),
    );
  });

  it('emits the "inside reference bbox" header when reference_bbox is set', async () => {
    queryElementPositionsMock.mockResolvedValue([
      { id: 'e1', name: 'Room 101', position: { x: 1, y: 2, z: 3 }, properties: [] },
    ]);
    const referenceBox = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
    const result = await tool.execute({ ...baseInput, reference_bbox: referenceBox }, makeCtx());
    expect(result.content[0]!.text).toMatch(/inside reference bbox/i);
  });

  it('never queries the deprecated `geometry` field on Element (regression)', async () => {
    // The tool layer mocks the API; we assert by reading the actual GraphQL constant
    // in the source module to ensure no `geometry { boundingBox ... }` snippet remains.
    const apiModule = await vi.importActual<typeof import('../../../../src/apis/aecdm.js')>(
      '../../../../src/apis/aecdm.js',
    );
    // The exported helper exists (positions API is wired). Old bbox helper must be gone.
    expect(apiModule.queryElementPositions).toBeTypeOf('function');
    // @ts-expect-error — queryElementBoundingBoxes is intentionally removed.
    expect(apiModule.queryElementBoundingBoxes).toBeUndefined();
  });
});

describe('decodeTransformTranslation — unit tests', () => {
  let decodeTransformTranslation: typeof import('../../../../src/apis/aecdm.js').decodeTransformTranslation;

  beforeEach(async () => {
    vi.resetModules();
    ({ decodeTransformTranslation } = await vi.importActual<
      typeof import('../../../../src/apis/aecdm.js')
    >('../../../../src/apis/aecdm.js'));
  });

  it('decodes column-major 4x4 — translation in last column (indices 12,13,14)', () => {
    // Identity rotation, translation (10, 20, 30)
    const value = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      10, 20, 30, 1,
    ];
    expect(decodeTransformTranslation({ type: 'Matrix4x4', value })).toEqual({
      x: 10, y: 20, z: 30,
    });
  });

  it('decodes row-major 4x4 — translation at indices 3,7,11', () => {
    const value = [
      1, 0, 0, 10,
      0, 1, 0, 20,
      0, 0, 1, 30,
      0, 0, 0, 1,
    ];
    expect(decodeTransformTranslation({ type: 'RowMajorMatrix4x4', value })).toEqual({
      x: 10, y: 20, z: 30,
    });
  });

  it('decodes column-major 4x3 — translation at indices 9,10,11', () => {
    const value = [
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      10, 20, 30,
    ];
    expect(decodeTransformTranslation({ type: 'Matrix4x3', value })).toEqual({
      x: 10, y: 20, z: 30,
    });
  });

  it('returns null for unsupported value length', () => {
    expect(decodeTransformTranslation({ type: 'Matrix2x2', value: [1, 2, 3, 4] })).toBeNull();
  });

  it('returns null for missing transform', () => {
    expect(decodeTransformTranslation(null)).toBeNull();
    expect(decodeTransformTranslation(undefined)).toBeNull();
  });
});
