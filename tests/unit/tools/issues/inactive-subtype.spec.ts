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
    subtypes: [
      { id: 'subtype-inactive', title: 'Design / Design', isActive: false },
      { id: 'subtype-active', title: 'Quality', isActive: true },
    ],
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

describe('issues_create buildPreview — inactive subtype rejection', () => {
  let createIssueTool: typeof import('../../../../src/tools/issues/create.js').createIssueTool;
  let BusinessRuleError: typeof import('../../../../src/safety/business-rules.js').BusinessRuleError;

  beforeEach(async () => {
    vi.resetModules();
    listIssueTypesMock.mockReset();
    listIssueTypesMock.mockResolvedValue(TYPES);
    ({ createIssueTool } = await import('../../../../src/tools/issues/create.js'));
    ({ BusinessRuleError } = await import('../../../../src/safety/business-rules.js'));
  });

  const baseInput = {
    project_id: 'b.proj-1',
    title: 'Test issue',
    status: 'open' as const,
    published: false,
  };

  it('throws BusinessRuleError when subtype is inactive', async () => {
    await expect(
      createIssueTool.buildPreview(
        { ...baseInput, issue_subtype_id: 'subtype-inactive' },
        makeCtx(),
      ),
    ).rejects.toThrowError(BusinessRuleError);
  });

  it('error rule slug is issue_subtype_must_be_active', async () => {
    try {
      await createIssueTool.buildPreview(
        { ...baseInput, issue_subtype_id: 'subtype-inactive' },
        makeCtx(),
      );
      expect.unreachable('buildPreview should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessRuleError);
      expect((err as InstanceType<typeof BusinessRuleError>).rule).toBe(
        'issue_subtype_must_be_active',
      );
    }
  });

  it('still throws when subtype id is unknown', async () => {
    try {
      await createIssueTool.buildPreview(
        { ...baseInput, issue_subtype_id: 'nope' },
        makeCtx(),
      );
      expect.unreachable('buildPreview should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessRuleError);
      expect((err as InstanceType<typeof BusinessRuleError>).rule).toBe(
        'issue_subtype_id_must_exist',
      );
    }
  });

  it('passes when subtype is active', async () => {
    const preview = await createIssueTool.buildPreview(
      { ...baseInput, issue_subtype_id: 'subtype-active' },
      makeCtx(),
    );
    expect(preview.businessRulesPassed).toContain('issue_subtype_is_active');
    expect(preview.businessRulesPassed).toContain('issue_subtype_id_exists_in_project');
  });
});

describe('issues_list_types — surfaces isActive', () => {
  let listIssueTypesTool: typeof import('../../../../src/tools/issues/list-types.js').listIssueTypesTool;

  beforeEach(async () => {
    vi.resetModules();
    listIssueTypesMock.mockReset();
    listIssueTypesMock.mockResolvedValue(TYPES);
    ({ listIssueTypesTool } = await import('../../../../src/tools/issues/list-types.js'));
  });

  it('includes isActive on every subtype in structuredContent', async () => {
    const result = await listIssueTypesTool.execute({ project_id: 'b.proj-1' }, makeCtx());
    const types = (result.structuredContent as { types: IssueType[] }).types;
    for (const t of types) {
      for (const s of t.subtypes) {
        expect(typeof s.isActive).toBe('boolean');
      }
    }
    expect(types[0]?.subtypes[0]?.isActive).toBe(false);
    expect(types[0]?.subtypes[1]?.isActive).toBe(true);
  });

  it('annotates inactive subtypes with [INACTIVE] in text rendering', async () => {
    const result = await listIssueTypesTool.execute({ project_id: 'b.proj-1' }, makeCtx());
    const text = result.content[0]!.text;
    expect(text).toMatch(/Design \/ Design.*\[INACTIVE\]/);
    expect(text).not.toMatch(/Quality.*\[INACTIVE\]/);
  });
});
