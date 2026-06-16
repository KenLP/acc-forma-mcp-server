import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IssueType } from '../../../../src/apis/issues.js';
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

const listIssueTypesMock = vi.fn<(...args: unknown[]) => Promise<IssueType[]>>();

vi.mock('../../../../src/apis/issues.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/apis/issues.js')>();
  return {
    ...actual,
    listIssueTypes: (...args: unknown[]) => listIssueTypesMock(...args),
  };
});

const TYPES: IssueType[] = [
  {
    id: 'type-1',
    title: 'Design',
    subtypes: [{ id: 'subtype-active', title: 'Quality', isActive: true }],
  },
];

function makeCtx(): ToolContext {
  return {
    auth: {
      getAccessToken: () => Promise.resolve('token'),
      getScopes: () => ['data:read', 'data:write'],
    },
    env: {} as ToolContext['env'],
  };
}

describe('issues_create buildPreview — linked_documents pushpin plumbing', () => {
  let createIssueTool: typeof import('../../../../src/tools/issues/create.js').createIssueTool;

  beforeEach(async () => {
    vi.resetModules();
    listIssueTypesMock.mockReset();
    listIssueTypesMock.mockResolvedValue(TYPES);
    ({ createIssueTool } = await import('../../../../src/tools/issues/create.js'));
  });

  const baseInput = {
    project_id: 'b.proj-1',
    title: 'Wall clashes with duct',
    status: 'open' as const,
    published: false,
    issue_subtype_id: 'subtype-active',
  };

  const samplePin = {
    type: 'ThreeDVectorPushpin' as const,
    urn: 'urn:adsk.wipprod:dm.lineage:abc123',
    createdAtVersion: 4,
    details: {
      viewable: {
        guid: 'viewable-guid-xyz',
        name: '{3D}',
        is3D: true,
        viewableId: '7',
      },
      position: { x: 12.5, y: 3.1, z: 8.0 },
      objectId: 4711,
      viewerState: { seedURN: 'urn:adsk.viewing:fs.file:...', objectSet: [] },
    },
  };

  it('omits linkedDocuments from the body when input is absent', async () => {
    const preview = await createIssueTool.buildPreview(baseInput, makeCtx());
    const body = preview.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('linkedDocuments');
  });

  it('forwards linked_documents into the APS body as linkedDocuments', async () => {
    const preview = await createIssueTool.buildPreview(
      { ...baseInput, linked_documents: [samplePin] },
      makeCtx(),
    );
    const body = preview.body as { linkedDocuments?: unknown[] };
    expect(body.linkedDocuments).toEqual([samplePin]);
  });

  it('binds linkedDocuments into executePayload (audit-chain integrity)', async () => {
    const preview = await createIssueTool.buildPreview(
      { ...baseInput, linked_documents: [samplePin] },
      makeCtx(),
    );
    const payload = preview.executePayload as { body: { linkedDocuments?: unknown[] } };
    expect(payload.body.linkedDocuments).toEqual([samplePin]);
  });

  it('records a side effect mentioning pushpin link count', async () => {
    const preview = await createIssueTool.buildPreview(
      { ...baseInput, linked_documents: [samplePin, { ...samplePin, objectId: 4712 }] },
      makeCtx(),
    );
    expect(preview.sideEffects.some((s) => s.includes('2 pushpin'))).toBe(true);
  });

  it('accepts TwoDVectorPushpin with minimal fields (just type + urn)', async () => {
    const minimal = {
      type: 'TwoDVectorPushpin' as const,
      urn: 'urn:adsk.wipprod:dm.lineage:sheet1',
    };
    const preview = await createIssueTool.buildPreview(
      { ...baseInput, linked_documents: [minimal] },
      makeCtx(),
    );
    const body = preview.body as { linkedDocuments?: unknown[] };
    expect(body.linkedDocuments).toEqual([minimal]);
  });

  it('rejects unknown pushpin type via Zod', () => {
    const schema = createIssueTool.inputSchema;
    const result = schema.safeParse({
      ...baseInput,
      linked_documents: [{ type: 'BogusPushpin', urn: 'urn:x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing urn via Zod', () => {
    const schema = createIssueTool.inputSchema;
    const result = schema.safeParse({
      ...baseInput,
      linked_documents: [{ type: 'TwoDVectorPushpin' }],
    });
    expect(result.success).toBe(false);
  });

  // ── TwoDRasterPushpin (2D PDF sheet) contract ──────────────────────────────

  const rasterPin = {
    type: 'TwoDRasterPushpin' as const,
    urn: 'urn:adsk.wipprod:dm.lineage:pdf1',
    createdAtVersion: 2,
    originContext: { product: 'docs', tool: 'files' },
    details: {
      viewable: { viewableId: 'Layout1', is3D: false },
      position: { x: 0.25, y: 0.6 },
    },
  };

  it('accepts a well-formed TwoDRasterPushpin and forwards it verbatim', async () => {
    const preview = await createIssueTool.buildPreview(
      { ...baseInput, linked_documents: [rasterPin] },
      makeCtx(),
    );
    const body = preview.body as { linkedDocuments?: unknown[] };
    expect(body.linkedDocuments).toEqual([rasterPin]);
  });

  it('rejects a raster pin with non-normalized position', () => {
    const schema = createIssueTool.inputSchema;
    const result = schema.safeParse({
      ...baseInput,
      linked_documents: [
        { ...rasterPin, details: { ...rasterPin.details, position: { x: 306, y: 396 } } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a raster pin carrying a z coordinate', () => {
    const schema = createIssueTool.inputSchema;
    const result = schema.safeParse({
      ...baseInput,
      linked_documents: [
        { ...rasterPin, details: { ...rasterPin.details, position: { x: 0.2, y: 0.3, z: 1 } } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a raster pin keyed on an SVF2 guid instead of viewableId', () => {
    const schema = createIssueTool.inputSchema;
    const result = schema.safeParse({
      ...baseInput,
      linked_documents: [
        {
          ...rasterPin,
          details: {
            viewable: { guid: 'svf2-guid-abc', is3D: false },
            position: { x: 0.2, y: 0.3 },
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a raster pin missing originContext', () => {
    const schema = createIssueTool.inputSchema;
    const noOriginContext = {
      type: rasterPin.type,
      urn: rasterPin.urn,
      createdAtVersion: rasterPin.createdAtVersion,
      details: rasterPin.details,
    };
    const result = schema.safeParse({
      ...baseInput,
      linked_documents: [noOriginContext],
    });
    expect(result.success).toBe(false);
  });

  it('does not impose raster rules on vector pins (3D z allowed)', () => {
    const schema = createIssueTool.inputSchema;
    const result = schema.safeParse({
      ...baseInput,
      linked_documents: [samplePin],
    });
    expect(result.success).toBe(true);
  });
});
