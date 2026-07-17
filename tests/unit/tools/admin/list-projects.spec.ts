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
      pagination: {
        limit: number;
        offset: number;
        totalResults?: number;
        hasMore: boolean;
        nextOffset: number | null;
      };
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
    // Raw page (3 rows) at offset 0 exhausts the raw totalResults (3) — no more pages.
    expect(structured.pagination.hasMore).toBe(false);
    expect(structured.pagination.nextOffset).toBeNull();
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
      pagination: { totalResults?: number; hasMore: boolean; nextOffset: number | null };
    };
    expect(structured.projects).toHaveLength(0);
    expect(structured.pagination.totalResults).toBeUndefined();
    expect('totalResults' in structured.pagination).toBe(false);
    // Raw page (1 row) at offset 0 exhausts the raw totalResults (1) — no more pages.
    expect(structured.pagination.hasMore).toBe(false);
    expect(structured.pagination.nextOffset).toBeNull();
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
      pagination: {
        limit: number;
        offset: number;
        totalResults: number;
        hasMore: boolean;
        nextOffset: number | null;
      };
    };

    // Nothing is filtered when the allow-list is wildcard, so the real cross-page total
    // must be reported. This is the regression this test guards against: with the
    // allow-list inactive (the default), a caller paginating a 300-project hub 50 at a
    // time must see 300, not this page's size (50) and not 0.
    expect(structured.projects).toHaveLength(50);
    expect(structured.pagination.totalResults).toBe(300);
    // 50 raw rows at offset 0, 300 total → more pages remain, next raw offset is 50.
    expect(structured.pagination.hasMore).toBe(true);
    expect(structured.pagination.nextOffset).toBe(50);
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
      pagination: { totalResults?: number; hasMore: boolean; nextOffset: number | null };
    };

    // This page has zero allowed projects, but that must NOT be reported as a total of
    // 0 — allowed projects exist on later pages this page-1 response knows nothing
    // about. And the unfiltered APS total (300) must not leak either.
    expect(structured.projects).toHaveLength(0);
    expect(structured.pagination.totalResults).toBeUndefined();
    expect('totalResults' in structured.pagination).toBe(false);
    expect(result.content[0]?.text).not.toMatch(/300/);
    // Defect B: even though this page filtered to zero allowed rows, hasMore/nextOffset
    // must still let the client reach page 2, where the allowed project lives. nextOffset
    // is derived from the RAW page size (2 rows), not the filtered count (0) — offset 0 +
    // 2 raw rows = 2.
    expect(structured.pagination.hasMore).toBe(true);
    expect(structured.pagination.nextOffset).toBe(2);
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

  it('reports the real totalResults when only the HUB allow-list is narrowed (guards Defect A: wrong predicate)', async () => {
    // FORMA_ALLOWED_HUBS is narrowed but FORMA_ALLOWED_PROJECTS is '*' — this tool only
    // ever filters by isProjectAllowed, so nothing on this page is actually removed. Using
    // isAllowlistActive() (true here, since the HUB list is narrowed) would wrongly strip
    // totalResults anyway. isProjectAllowlistActive() must be false here, so totalResults
    // passes through unchanged.
    vi.doMock('../../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: 'b.hub-x',
        FORMA_ALLOWED_PROJECTS: '*',
      },
    }));
    const pageOfResults = [
      { id: 'proj-a', name: 'Project A', status: 'active' },
      { id: 'proj-b', name: 'Project B', status: 'active' },
    ];
    vi.doMock('../../../../src/apis/admin.js', () => ({
      adminListProjects: vi.fn().mockResolvedValue({
        results: pageOfResults,
        pagination: { limit: 50, offset: 0, totalResults: 2 },
      }),
    }));

    const { adminListProjectsTool } = await import('../../../../src/tools/admin/list-projects.js');
    const ctx = makeCtx();

    const result = await adminListProjectsTool.execute(
      { hub_id: 'hub-x', limit: 50, offset: 0 },
      ctx,
    );

    const structured = result.structuredContent as {
      projects: unknown[];
      pagination: { totalResults?: number; hasMore: boolean; nextOffset: number | null };
    };

    expect(structured.projects).toHaveLength(2);
    expect(structured.pagination.totalResults).toBe(2);
    expect(structured.pagination.hasMore).toBe(false);
    expect(structured.pagination.nextOffset).toBeNull();
  });

  it('lets a client reach page 2 when page 1 is a full raw page with zero allowed rows (guards Defect B)', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: '*',
        // The one allowed project lives beyond this full page-1 response.
        FORMA_ALLOWED_PROJECTS: ALLOWED_PROJECT,
      },
    }));
    const limit = 50;
    const fullBlockedPage = Array.from({ length: limit }, (_, i) => ({
      id: `blocked-${i}`,
      name: `Blocked ${i}`,
      status: 'active',
    }));
    vi.doMock('../../../../src/apis/admin.js', () => ({
      adminListProjects: vi.fn().mockResolvedValue({
        results: fullBlockedPage,
        pagination: { limit, offset: 0, totalResults: 120 },
      }),
    }));

    const { adminListProjectsTool } = await import('../../../../src/tools/admin/list-projects.js');
    const ctx = makeCtx();

    const result = await adminListProjectsTool.execute({ hub_id: 'hub-1', limit, offset: 0 }, ctx);

    const structured = result.structuredContent as {
      projects: unknown[];
      pagination: { totalResults?: number; hasMore: boolean; nextOffset: number | null };
    };

    expect(structured.projects).toHaveLength(0);
    expect(structured.pagination.totalResults).toBeUndefined();
    // hasMore/nextOffset are the ONLY signal a client has to keep paginating past an
    // all-filtered page — without them this page would look indistinguishable from "no
    // more results" and the client would stop before reaching the allowed project.
    expect(structured.pagination.hasMore).toBe(true);
    expect(structured.pagination.nextOffset).toBe(limit);
  });

  it('derives nextOffset from the raw page size, not the filtered count, when filtering removes some but not all rows', async () => {
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
          { id: 'blocked-1', name: 'Blocked 1', status: 'active' },
          { id: 'blocked-2', name: 'Blocked 2', status: 'active' },
          { id: 'blocked-3', name: 'Blocked 3', status: 'active' },
        ],
        // Raw page is 4 rows starting at offset 10; 50 total rows exist across the hub.
        pagination: { limit: 4, offset: 10, totalResults: 50 },
      }),
    }));

    const { adminListProjectsTool } = await import('../../../../src/tools/admin/list-projects.js');
    const ctx = makeCtx();

    const result = await adminListProjectsTool.execute(
      { hub_id: 'hub-1', limit: 4, offset: 10 },
      ctx,
    );

    const structured = result.structuredContent as {
      projects: Array<{ id: string }>;
      pagination: { hasMore: boolean; nextOffset: number | null };
    };

    // Filtering left only 1 of the 4 raw rows. If nextOffset were (wrongly) derived from
    // the filtered count it would be 10 + 1 = 11, which would re-read 3 already-seen raw
    // rows on the next call. The raw page has 4 rows, so the correct next raw offset is
    // 10 + 4 = 14.
    expect(structured.projects).toHaveLength(1);
    expect(structured.pagination.hasMore).toBe(true);
    expect(structured.pagination.nextOffset).toBe(14);
  });

  it('reports hasMore false and nextOffset null on the last page', async () => {
    vi.doMock('../../../../src/config/env.js', () => ({
      env: {
        FORMA_ALLOWED_HUBS: '*',
        FORMA_ALLOWED_PROJECTS: ALLOWED_PROJECT,
      },
    }));
    vi.doMock('../../../../src/apis/admin.js', () => ({
      adminListProjects: vi.fn().mockResolvedValue({
        results: [{ id: ALLOWED_PROJECT, name: 'Allowed Project', status: 'active' }],
        // Raw page is the tail end of a 101-row hub: offset 100 + 1 row === totalResults.
        pagination: { limit: 50, offset: 100, totalResults: 101 },
      }),
    }));

    const { adminListProjectsTool } = await import('../../../../src/tools/admin/list-projects.js');
    const ctx = makeCtx();

    const result = await adminListProjectsTool.execute(
      { hub_id: 'hub-1', limit: 50, offset: 100 },
      ctx,
    );

    const structured = result.structuredContent as {
      projects: unknown[];
      pagination: { hasMore: boolean; nextOffset: number | null };
    };

    expect(structured.projects).toHaveLength(1);
    expect(structured.pagination.hasMore).toBe(false);
    expect(structured.pagination.nextOffset).toBeNull();
  });
});
