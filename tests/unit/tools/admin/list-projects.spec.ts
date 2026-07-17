import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '../../../../src/tools/_types.js';

// src/safety/allowlist.ts imports src/config/env.ts, which THROWS at import time when
// APS creds are absent — mock env before importing anything that reaches it, and re-import
// after resetting modules so the allow-list Set is parsed from our mocked env value.
// (Same pattern as tests/unit/tools/registry-scope.spec.ts.) allowlist.ts parses its env
// vars ONCE at module load, so each allow-list configuration below needs its own
// vi.resetModules() + fresh dynamic import — a single import cannot see two configs.

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

  it('omits totalResults (not the filtered count, not the unfiltered count) once the allow-list removes rows', async () => {
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
      pagination: { limit: number; offset: number; totalResults?: number };
    };

    // Only the allowed project should be returned...
    expect(structured.projects).toHaveLength(1);
    expect(structured.projects[0]?.id).toBe(ALLOWED_PROJECT);
    // ...and totalResults must be ABSENT — neither the unfiltered APS count (3, which
    // would leak that 2 more projects exist outside the allow-list) nor the filtered
    // page count (1, which is not a valid cross-page total either).
    expect(structured.pagination.totalResults).toBeUndefined();
    expect('totalResults' in structured.pagination).toBe(false);
    expect(structured.pagination.limit).toBe(50);
    expect(structured.pagination.offset).toBe(0);
  });

  it('omits totalResults (does not fall back to 0) when every row on the page is filtered out', async () => {
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
      pagination: { totalResults?: number };
    };
    expect(structured.projects).toHaveLength(0);
    expect(structured.pagination.totalResults).toBeUndefined();
    expect('totalResults' in structured.pagination).toBe(false);
  });

  it('passes the real totalResults through unchanged when the allow-list is wildcard (regression guard)', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: '*',
        FORMA_ALLOWED_PROJECTS: '*',
      },
    }));
    const pageOfResults = Array.from({ length: 50 }, (_, i) => ({
      id: `proj-${i}`,
      name: `Project ${i}`,
      status: 'active',
    }));
    vi.doMock('../../../../src/apis/admin.js', () => ({
      adminListProjects: vi.fn().mockResolvedValue({
        results: pageOfResults,
        // 300 projects exist across all pages; this call returned page 1 (50 rows).
        pagination: { limit: 50, offset: 0, totalResults: 300 },
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
      pagination: { limit: number; offset: number; totalResults: number };
    };

    // Nothing is filtered when the allow-list is wildcard, so the real cross-page total
    // must be reported. This is the regression this test guards against: with the
    // allow-list inactive (the default), a caller paginating a 300-project hub 50 at a
    // time must see 300, not this page's size (50) and not 0.
    expect(structured.projects).toHaveLength(50);
    expect(structured.pagination.totalResults).toBe(300);
  });

  it('omits totalResults on a page with zero allowed rows even though later pages hold allowed projects', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: '*',
        // The one allowed project lives on a later page — this page-1 mock below
        // contains none of it.
        FORMA_ALLOWED_PROJECTS: ALLOWED_PROJECT,
      },
    }));
    vi.doMock('../../../../src/apis/admin.js', () => ({
      adminListProjects: vi.fn().mockResolvedValue({
        results: [
          { id: 'proj-p1-a', name: 'Page 1 Project A', status: 'active' },
          { id: 'proj-p1-b', name: 'Page 1 Project B', status: 'active' },
        ],
        // APS says 300 projects exist in total across pages; none of these page-1 rows
        // are inside the allow-list, but the allowed project exists on a later page.
        pagination: { limit: 50, offset: 0, totalResults: 300 },
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
      pagination: { totalResults?: number };
    };

    // This page has zero allowed projects, but that must NOT be reported as a total of
    // 0 — allowed projects exist on later pages this page-1 response knows nothing
    // about. And the unfiltered APS total (300) must not leak either.
    expect(structured.projects).toHaveLength(0);
    expect(structured.pagination.totalResults).toBeUndefined();
    expect('totalResults' in structured.pagination).toBe(false);
    expect(result.content[0]?.text).not.toMatch(/300/);
  });

  it('never exposes the unfiltered total in text or structuredContent when the allow-list allows only some rows', async () => {
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
        ],
        pagination: { limit: 50, offset: 0, totalResults: 147 },
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
      pagination: Record<string, unknown>;
    };

    expect(JSON.stringify(structured.pagination)).not.toContain('147');
    expect(result.content[0]?.text).not.toContain('147');
    // Only the allowed project should appear in the rendered text.
    expect(result.content[0]?.text).not.toContain(BLOCKED_PROJECT);
  });
});
