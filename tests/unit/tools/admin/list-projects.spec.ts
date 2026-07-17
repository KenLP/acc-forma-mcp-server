import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '../../../../src/tools/_types.js';

// src/safety/allowlist.ts imports src/config/env.ts, which THROWS at import time when
// APS creds are absent — mock env before importing anything that reaches it, and re-import
// after resetting modules so the allow-list Set is parsed from our mocked env value.
// (Same pattern as tests/unit/tools/registry-scope.spec.ts.)

const ALLOWED_PROJECT = 'proj-allowed';
const BLOCKED_PROJECT = 'proj-blocked';

function makeCtx(): ToolContext {
  return {
    auth: { getAccessToken: vi.fn().mockResolvedValue('tok'), getScopes: vi.fn().mockReturnValue([]) },
    env: {} as ToolContext['env'],
  };
}

describe('admin_list_projects — allow-list count leak', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not expose the unfiltered totalResults once the allow-list removes rows', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: '*',
        FORMA_ALLOWED_PROJECTS: ALLOWED_PROJECT,
      },
    }));
    vi.doMock('../../../../src/apis/admin.js', () => ({
      adminListProjects: vi.fn().mockResolvedValue({
        results: [
          { id: ALLOWED_PROJECT, name: 'Allowed Project', status: 'active' },
          { id: BLOCKED_PROJECT, name: 'Blocked Project', status: 'active' },
          { id: 'proj-blocked-2', name: 'Another Blocked Project', status: 'active' },
        ],
        // APS reports 3 projects exist in the hub; only 1 is inside the allow-list.
        pagination: { limit: 50, offset: 0, totalResults: 3 },
      }),
    }));

    const { adminListProjectsTool } = await import('../../../../src/tools/admin/list-projects.js');
    const ctx = makeCtx();

    const result = await adminListProjectsTool.execute(
      { hub_id: 'hub-1', limit: 50, offset: 0 },
      ctx,
    );

    const structured = result.structuredContent as {
      projects: Array<{ id: string }>;
      pagination: { totalResults: number };
    };

    // Only the allowed project should be returned...
    expect(structured.projects).toHaveLength(1);
    expect(structured.projects[0]?.id).toBe(ALLOWED_PROJECT);
    // ...and totalResults must reflect the FILTERED count (1), never the unfiltered
    // APS count (3) — the unfiltered number would leak that 2 more projects exist
    // outside the allow-list.
    expect(structured.pagination.totalResults).toBe(1);
    expect(structured.pagination.totalResults).not.toBe(3);
  });

  it('reports totalResults 0 (not the unfiltered count) when every row is filtered out', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: '*',
        FORMA_ALLOWED_PROJECTS: ALLOWED_PROJECT,
      },
    }));
    vi.doMock('../../../../src/apis/admin.js', () => ({
      adminListProjects: vi.fn().mockResolvedValue({
        results: [{ id: BLOCKED_PROJECT, name: 'Blocked Project', status: 'active' }],
        pagination: { limit: 50, offset: 0, totalResults: 1 },
      }),
    }));

    const { adminListProjectsTool } = await import('../../../../src/tools/admin/list-projects.js');
    const ctx = makeCtx();

    const result = await adminListProjectsTool.execute(
      { hub_id: 'hub-1', limit: 50, offset: 0 },
      ctx,
    );

    const structured = result.structuredContent as {
      projects: unknown[];
      pagination: { totalResults: number };
    };
    expect(structured.projects).toHaveLength(0);
    expect(structured.pagination.totalResults).toBe(0);
  });
});
