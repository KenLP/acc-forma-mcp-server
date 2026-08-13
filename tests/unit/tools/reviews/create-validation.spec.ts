import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../../src/tools/_types.js';
import type { Env } from '../../../../src/config/env.js';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

vi.mock('../../../../src/apis/reviews.js', () => ({
  createReview: vi.fn(),
}));

function makeEnv(): Env {
  return {
    APS_AUTH_MODE: 'ssa',
    APS_REGION: 'US',
    SSA_ID: 'test-ssa',
    APS_CLIENT_ID: 'test-client',
    APS_CLIENT_SECRET: 'test-secret',
    SSA_KEY_ID: 'key-id',
    SSA_KEY_PATH: '/tmp/key.pem',
    FORMA_ALLOWED_HUBS: '*',
    FORMA_ALLOWED_PROJECTS: '*',
    FORMA_MUTATION_MODE: 'preview_required',
    FORMA_READONLY: false,
    FORMA_AUDIT_DIR: '/tmp/test-audit',
    FORMA_AUDIT_INCLUDE_READS: true,
    FORMA_AUDIT_INDEX: 'none',
    FORMA_AUDIT_RETENTION_DAYS: 90,
    FORMA_APPROVAL_TOKEN_TTL: 300,
    FORMA_RATE_CONFIG_PATH: undefined,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
  } as unknown as Env;
}

function makeCtx(): ToolContext {
  return {
    auth: {
      getAccessToken: vi.fn().mockResolvedValue('tok'),
      getScopes: vi.fn().mockReturnValue(['data:read', 'data:write']),
    },
    env: makeEnv(),
  };
}

const VERSIONED = 'urn:adsk.wipprod:fs.file:vf.D6rEDK6lSbW9PTWkTAmu0A?version=1';
const LINEAGE_ONLY = 'urn:adsk.wipprod:dm.lineage:D6rEDK6lSbW9PTWkTAmu0A';

const BASE_INPUT = {
  project_id: 'b.proj-1',
  name: 'Structural Review',
  workflow_id: 'b3f5e818-dcd6-49d8-8d47-ba505988d7b7',
  file_versions: [{ urn: VERSIONED }],
  dry_run: true as const,
};

// ACC answers an unversioned URN with `should match format "versionedFileUrn"`, naming an
// internal type the caller cannot act on. The validator catches it first, before the
// approval token is issued, so the message says which URN is wrong and why.
describe('reviews_create — file version URN validator', () => {
  let wrapMutationTool: typeof import('../../../../src/tools/_wrap.js').wrapMutationTool;
  let createReviewTool: typeof import('../../../../src/tools/reviews/create.js').createReviewTool;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../../../src/config/env.js', () => ({ env: makeEnv() }));
    ({ wrapMutationTool } = await import('../../../../src/tools/_wrap.js'));
    ({ createReviewTool } = await import('../../../../src/tools/reviews/create.js'));
  });

  it('rejects a lineage URN with no version suffix, naming the offender', async () => {
    const wrapped = wrapMutationTool(createReviewTool, makeCtx());
    const result = await wrapped({ ...BASE_INPUT, file_versions: [{ urn: LINEAGE_ONLY }] });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/version/i);
    expect(result.content[0]?.text).toContain(LINEAGE_ONLY);
  });

  it('rejects the batch when only one of several URNs is unversioned', async () => {
    const wrapped = wrapMutationTool(createReviewTool, makeCtx());
    const result = await wrapped({
      ...BASE_INPUT,
      file_versions: [{ urn: VERSIONED }, { urn: LINEAGE_ONLY }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('1 of 2');
  });

  it('accepts versioned URNs and returns a preview', async () => {
    const wrapped = wrapMutationTool(createReviewTool, makeCtx());
    const result = await wrapped(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty('preview');
  });

  it("previews the body ACC actually accepts — no reviewer or due-date fields", async () => {
    const wrapped = wrapMutationTool(createReviewTool, makeCtx());
    const result = await wrapped(BASE_INPUT);

    const preview = (result.structuredContent as { preview: { body: Record<string, unknown> } })
      .preview;
    expect(Object.keys(preview.body).sort()).toEqual(['fileVersions', 'name', 'workflowId']);
    expect(preview.body['fileVersions']).toEqual([{ urn: VERSIONED }]);
  });
});
