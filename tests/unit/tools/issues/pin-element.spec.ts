import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IssueType, Issue } from '../../../../src/apis/issues.js';
import type { MdManifest, MdElement, MdView } from '../../../../src/apis/model-derivative.js';
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

const listIssueTypesMock = vi.fn<(...args: unknown[]) => Promise<IssueType[]>>();
const createIssueMock = vi.fn<(...args: unknown[]) => Promise<Issue>>();

vi.mock('../../../../src/apis/issues.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/apis/issues.js')>();
  return {
    ...actual,
    listIssueTypes: (...args: unknown[]) => listIssueTypesMock(...args),
    createIssue: (...args: unknown[]) => createIssueMock(...args),
  };
});

const getMdManifestMock = vi.fn<(...args: unknown[]) => Promise<MdManifest>>();
const getMdPropertiesMock = vi.fn<(...args: unknown[]) => Promise<MdElement[]>>();
const getMdViewsMock = vi.fn<(...args: unknown[]) => Promise<MdView[]>>();

vi.mock('../../../../src/apis/model-derivative.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/apis/model-derivative.js')>();
  return {
    ...actual,
    getMdManifest: (...args: unknown[]) => getMdManifestMock(...args),
    getMdProperties: (...args: unknown[]) => getMdPropertiesMock(...args),
    getMdViews: (...args: unknown[]) => getMdViewsMock(...args),
    // extractDocsViewables is pure — let it run on the mock manifest data
  };
});

const queryElementPositionsMock = vi.fn<(...args: unknown[]) => Promise<AecElementPosition[]>>();

vi.mock('../../../../src/apis/aecdm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/apis/aecdm.js')>();
  return {
    ...actual,
    queryElementPositions: (...args: unknown[]) => queryElementPositionsMock(...args),
  };
});

const apsRequestMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../../../../src/http/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/http/client.js')>();
  return {
    ...actual,
    apsRequest: (...args: unknown[]) => apsRequestMock(...args),
  };
});

// ---- Fixtures ---------------------------------------------------------------

const TYPES: IssueType[] = [
  {
    id: 'type-1',
    title: 'Design',
    subtypes: [
      { id: 'subtype-active', title: 'Quality', isActive: true },
      { id: 'subtype-inactive', title: 'Old', isActive: false },
    ],
  },
];

/** Minimal SVF2 manifest with one 3D viewable and one 2D viewable */
const MANIFEST: MdManifest = {
  urn: 'urn:adsk.wipprod:fs.file:vf.testlineage?version=1',
  status: 'success',
  progress: '100%',
  derivatives: [
    {
      outputType: 'svf2',
      status: 'success',
      children: [
        {
          guid: 'root-folder-guid',
          type: 'folder',
          role: 'root',
          children: [
            {
              guid: '3d-view-guid',
              type: 'geometry',
              role: '3d',
              name: '{3D}',
            },
            {
              guid: '2d-view-guid',
              type: 'geometry',
              role: '2d',
              name: 'Floor Plan Level 1',
            },
          ],
        },
      ],
    },
  ],
};

/** Manifest with two named 3D views for hint matching */
const MANIFEST_MULTI_3D: MdManifest = {
  ...MANIFEST,
  derivatives: [
    {
      outputType: 'svf2',
      status: 'success',
      children: [
        {
          guid: 'root-folder-guid',
          type: 'folder',
          role: 'root',
          children: [
            { guid: 'arch-3d-guid', type: 'geometry', role: '3d', name: '3D Architectural' },
            { guid: 'plumb-3d-guid', type: 'geometry', role: '3d', name: '3D Plumbing' },
          ],
        },
      ],
    },
  ],
};

const ELEMENT: AecElementPosition = {
  id: 'aecdm-el-001',
  name: 'Double-Flush [920000]',
  position: { x: 1.1441, y: -8.5012, z: 0.0 },
  externalId: 'ext-id-door-001',
  revitElementId: '920000',
  properties: [
    { name: 'External ID', value: 'ext-id-door-001' },
    { name: 'Revit Element ID', value: '920000' },
  ],
};

const MD_ELEMENTS: MdElement[] = [
  { objectId: 1234, name: 'Double-Flush', externalId: 'ext-id-door-001' },
];

const ISSUES_WITH_OFFSET = {
  results: [
    {
      linkedDocuments: [
        {
          details: {
            viewerState: {
              globalOffset: { x: -19.068394820, y: -5.405197144, z: 25.708333651 },
            },
          },
        },
      ],
    },
  ],
};

const BASE_INPUT = {
  project_id: 'b.proj-001',
  element_group_id: 'urn:adsk.aecdm:el-group:abc',
  category: 'Doors',
  element_external_id: 'ext-id-door-001',
  model_version_urn: 'urn:adsk.wipprod:fs.file:vf.testlineage?version=1',
  title: 'Door clearance issue',
  issue_subtype_id: 'subtype-active',
  status: 'open' as const,
  published: false,
  unit_factor: 3.280839895,
};

function makeCtx(): ToolContext {
  return {
    auth: {
      getAccessToken: () => Promise.resolve('token'),
      getScopes: () => ['data:read', 'data:write'],
    },
    env: {} as ToolContext['env'],
  };
}

// ---- Tests ------------------------------------------------------------------

describe('issues_pin_element — buildPreview', () => {
  let tool: typeof import('../../../../src/tools/issues/pin-element.js').pinElementTool;

  beforeEach(async () => {
    vi.resetModules();
    listIssueTypesMock.mockReset().mockResolvedValue(TYPES);
    getMdManifestMock.mockReset().mockResolvedValue(MANIFEST);
    getMdViewsMock.mockReset().mockResolvedValue([
      { guid: '3d-meta-guid', name: '{3D}', role: '3d' as const },
    ]);
    queryElementPositionsMock.mockReset().mockResolvedValue([ELEMENT]);
    getMdPropertiesMock.mockReset().mockResolvedValue(MD_ELEMENTS);
    apsRequestMock.mockReset().mockResolvedValue(ISSUES_WITH_OFFSET);
    createIssueMock.mockReset();
    ({ pinElementTool: tool } = await import('../../../../src/tools/issues/pin-element.js'));
  });

  it('resolves position, objectId, and globalOffset from existing pins', async () => {
    const preview = await tool.buildPreview(BASE_INPUT, makeCtx());

    expect(preview.method).toBe('POST');
    expect(preview.url).toContain('/projects/proj-001/issues');

    const body = preview.body as Record<string, unknown>;
    expect(body['title']).toBe('Door clearance issue');
    expect(body['issueSubtypeId']).toBe('subtype-active');
    expect(body['linkedDocuments']).toHaveLength(1);

    const pin = (body['linkedDocuments'] as Array<Record<string, unknown>>)[0];
    expect(pin!['type']).toBe('TwoDVectorPushpin');
    expect(pin!['urn']).toBe('urn:adsk.wipprod:dm.lineage:testlineage');

    const details = pin!['details'] as Record<string, unknown>;
    expect((details['viewable'] as Record<string, unknown>)['guid']).toBe('3d-view-guid');
    expect((details['viewable'] as Record<string, unknown>)['is3D']).toBe(true);
    expect(details['objectId']).toBe(1234);
    expect(details['externalId']).toBe('ext-id-door-001');

    // Verify position transform: AECDM metres × 3.280839895 − globalOffset
    const pos = details['position'] as { x: number; y: number; z: number };
    expect(pos.x).toBeCloseTo(1.1441 * 3.280839895 - (-19.068394820), 3);
    expect(pos.y).toBeCloseTo(-8.5012 * 3.280839895 - (-5.405197144), 3);

    expect(preview.businessRulesPassed).toContain('element_found_in_aecdm_category');
    expect(preview.businessRulesPassed).toContain('element_has_geometry_origin');
    expect(preview.businessRulesPassed).toContain('global_offset_calibrated');
    expect(preview.businessRulesPassed).toContain('object_id_resolved');
    expect(preview.sideEffects.join(' ')).toContain('existing_pin');
  });

  it('uses provided global_offset and skips the issues query', async () => {
    const offset = { x: -14.327, y: 3.055, z: 26.715 };
    const preview = await tool.buildPreview({ ...BASE_INPUT, global_offset: offset }, makeCtx());

    // apsRequest should NOT be called when global_offset is explicitly provided
    expect(apsRequestMock).not.toHaveBeenCalled();

    const pin = ((preview.body as Record<string, unknown>)['linkedDocuments'] as Array<Record<string, unknown>>)[0];
    const pos = (pin!['details'] as Record<string, unknown>)['position'] as { x: number; y: number; z: number };
    expect(pos.x).toBeCloseTo(1.1441 * 3.280839895 - (-14.327), 2);

    expect(preview.sideEffects.join(' ')).toContain('provided');
  });

  it('falls back to zero offset with a WARNING when no existing pins found', async () => {
    apsRequestMock.mockResolvedValue({ results: [] });

    const preview = await tool.buildPreview(BASE_INPUT, makeCtx());

    const pos = (((preview.body as Record<string, unknown>)['linkedDocuments'] as Array<Record<string, unknown>>)[0]!['details'] as Record<string, unknown>)['position'] as { x: number; y: number; z: number };
    // With zero offset, position = AECDM × unitFactor
    expect(pos.x).toBeCloseTo(1.1441 * 3.280839895, 3);

    expect(preview.businessRulesPassed).not.toContain('global_offset_calibrated');
    expect(preview.sideEffects.some((s) => s.includes('WARNING'))).toBe(true);
    expect(preview.sideEffects.some((s) => s.includes('0,0,0'))).toBe(true);
  });

  it('selects viewable matching viewable_name_hint', async () => {
    getMdManifestMock.mockResolvedValue(MANIFEST_MULTI_3D);

    const preview = await tool.buildPreview(
      { ...BASE_INPUT, viewable_name_hint: 'Plumbing' },
      makeCtx(),
    );

    const pin = ((preview.body as Record<string, unknown>)['linkedDocuments'] as Array<Record<string, unknown>>)[0]!;
    const viewable = (pin['details'] as Record<string, unknown>)['viewable'] as Record<string, unknown>;
    expect(viewable['guid']).toBe('plumb-3d-guid');
    expect(viewable['name']).toBe('3D Plumbing');
  });

  it('falls back to first 3D view when hint has no match', async () => {
    getMdManifestMock.mockResolvedValue(MANIFEST_MULTI_3D);

    const preview = await tool.buildPreview(
      { ...BASE_INPUT, viewable_name_hint: 'nonexistent hint' },
      makeCtx(),
    );

    const pin = ((preview.body as Record<string, unknown>)['linkedDocuments'] as Array<Record<string, unknown>>)[0]!;
    const viewable = (pin['details'] as Record<string, unknown>)['viewable'] as Record<string, unknown>;
    expect(viewable['guid']).toBe('arch-3d-guid'); // first 3D viewable
  });

  it('omits objectId when MD properties lookup fails (pin still created)', async () => {
    getMdPropertiesMock.mockRejectedValue(new Error('MD not available'));

    const preview = await tool.buildPreview(BASE_INPUT, makeCtx());

    const pin = ((preview.body as Record<string, unknown>)['linkedDocuments'] as Array<Record<string, unknown>>)[0]!;
    const details = pin['details'] as Record<string, unknown>;
    expect(details['objectId']).toBeUndefined();
    expect(preview.businessRulesPassed).not.toContain('object_id_resolved');
  });

  it('throws BusinessRuleError when subtype not found', async () => {
    await expect(
      tool.buildPreview({ ...BASE_INPUT, issue_subtype_id: 'not-a-subtype' }, makeCtx()),
    ).rejects.toMatchObject({ rule: 'issue_subtype_id_must_exist' });
  });

  it('throws BusinessRuleError when subtype is inactive', async () => {
    await expect(
      tool.buildPreview({ ...BASE_INPUT, issue_subtype_id: 'subtype-inactive' }, makeCtx()),
    ).rejects.toMatchObject({ rule: 'issue_subtype_must_be_active' });
  });

  it('throws BusinessRuleError when no 3D viewable in manifest', async () => {
    getMdManifestMock.mockResolvedValue({
      ...MANIFEST,
      derivatives: [
        {
          outputType: 'svf2',
          status: 'success',
          children: [{ guid: '2d-only', type: 'geometry', role: '2d', name: 'Sheet 1' }],
        },
      ],
    });

    await expect(
      tool.buildPreview(BASE_INPUT, makeCtx()),
    ).rejects.toMatchObject({ rule: 'no_3d_viewable' });
  });

  it('throws BusinessRuleError when element externalId not found in category', async () => {
    queryElementPositionsMock.mockResolvedValue([
      { ...ELEMENT, externalId: 'different-ext-id' },
    ]);

    await expect(
      tool.buildPreview(BASE_INPUT, makeCtx()),
    ).rejects.toMatchObject({ rule: 'element_not_found' });
  });

  it('throws BusinessRuleError when element has no geometry (null position)', async () => {
    queryElementPositionsMock.mockResolvedValue([
      { ...ELEMENT, position: null },
    ]);

    await expect(
      tool.buildPreview(BASE_INPUT, makeCtx()),
    ).rejects.toMatchObject({ rule: 'element_has_no_geometry' });
  });

  it('executePayload includes project ID and issue body for token binding', async () => {
    const preview = await tool.buildPreview(BASE_INPUT, makeCtx());
    const payload = preview.executePayload as Record<string, unknown>;

    expect(payload['toolName']).toBe('issues_pin_element');
    expect(payload['projectId']).toBe('proj-001'); // b. prefix stripped
    const payloadBody = payload['body'] as Record<string, unknown>;
    expect(payloadBody['title']).toBe('Door clearance issue');
    expect(payloadBody['linkedDocuments']).toHaveLength(1);
  });
});
