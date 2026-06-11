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
  resolveReviewsContainerId: vi.fn().mockResolvedValue('container-123'),
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

const PAST_DATE = '2020-01-01';
const FUTURE_DATE = '2099-12-31';

const BASE_INPUT = {
  hub_id: 'b.hub-1',
  project_id: 'b.proj-1',
  name: 'Structural Review',
  reviewer_ids: ['user-abc'],
  dry_run: true as const,
};

describe('reviews_create — due_date business-rule validator (R2-9)', () => {
  let wrapMutationTool: typeof import('../../../../src/tools/_wrap.js').wrapMutationTool;
  let createReviewTool: typeof import('../../../../src/tools/reviews/create.js').createReviewTool;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../../../src/config/env.js', () => ({ env: makeEnv() }));
    ({ wrapMutationTool } = await import('../../../../src/tools/_wrap.js'));
    ({ createReviewTool } = await import('../../../../src/tools/reviews/create.js'));
  });

  it('rejects a past due_date with isError and informative message', async () => {
    const wrapped = wrapMutationTool(createReviewTool, makeCtx());
    const result = await wrapped({ ...BASE_INPUT, due_date: PAST_DATE });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/due_date.*past|past.*due_date/i);
    expect(result.content[0]?.text).toContain(PAST_DATE);
  });

  it('accepts a future due_date and returns a preview', async () => {
    const wrapped = wrapMutationTool(createReviewTool, makeCtx());
    const result = await wrapped({ ...BASE_INPUT, due_date: FUTURE_DATE });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty('preview');
  });

  it('accepts input with no due_date', async () => {
    const wrapped = wrapMutationTool(createReviewTool, makeCtx());
    const result = await wrapped(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty('preview');
  });
});
