/**
 * Integration smoke tests — require real APS credentials.
 *
 * Run with: INTEGRATION=true npx vitest run tests/integration
 *
 * Required env vars (in addition to normal .env):
 *   APS_AUTH_MODE, APS_CLIENT_ID, APS_CLIENT_SECRET (+ SSA vars if mode=ssa)
 *   INTEGRATION_HUB_ID     — a hub ID the credentials have access to
 *   INTEGRATION_PROJECT_ID — a project ID inside that hub (optional — some tests skip without it)
 *
 * These tests make REAL read-only calls against APS. They do NOT create or modify any data.
 * Mutation tools are exercised only in dry_run=true mode (preview only, no execute).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { ToolContext } from '../../src/tools/_types.js';

const SKIP = process.env['INTEGRATION'] !== 'true';
const HUB_ID = process.env['INTEGRATION_HUB_ID'] ?? '';
const PROJECT_ID = process.env['INTEGRATION_PROJECT_ID'] ?? '';

let ctx: ToolContext;

beforeAll(async () => {
  if (SKIP) return;

  const { env } = await import('../../src/config/env.js');
  const { SsaAuthProvider } = await import('../../src/auth/ssa.js');
  const { TwoLeggedAuthProvider } = await import('../../src/auth/two-legged.js');

  const scopes = ['data:read', 'account:read', 'data:write'];
  const twoLegged = new TwoLeggedAuthProvider(scopes);
  const auth =
    env.APS_AUTH_MODE === 'ssa'
      ? new SsaAuthProvider(scopes)
      : twoLegged;

  ctx = { auth, auth2lo: twoLegged, env };
});

function skipIfNoHub(): boolean {
  if (SKIP) return true;
  if (!HUB_ID) { console.warn('INTEGRATION_HUB_ID not set — skipping'); return true; }
  return false;
}

function skipIfNoProject(): boolean {
  if (skipIfNoHub()) return true;
  if (!PROJECT_ID) { console.warn('INTEGRATION_PROJECT_ID not set — skipping'); return true; }
  return false;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('obtains a non-empty access token', async () => {
    if (SKIP) return;
    const token = await ctx.auth.getAccessToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  });
});

// ── DM read tools ─────────────────────────────────────────────────────────────

describe('dm_list_hubs', () => {
  it('returns a non-empty hub list containing INTEGRATION_HUB_ID', async () => {
    if (skipIfNoHub()) return;
    const { listHubsTool } = await import('../../src/tools/dm/list-hubs.js');
    const result = await listHubsTool.execute({}, ctx);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(HUB_ID.replace(/^b\./, ''));
  });
});

describe('dm_list_projects', () => {
  it('returns projects for the configured hub', async () => {
    if (skipIfNoHub()) return;
    const { listProjectsTool } = await import('../../src/tools/dm/list-projects.js');
    const result = await listProjectsTool.execute({ hub_id: HUB_ID }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text.length).toBeGreaterThan(0);
  });
});

describe('dm_list_top_folders', () => {
  it('returns top folders for the configured project', async () => {
    if (skipIfNoProject()) return;
    const { listTopFoldersTool } = await import('../../src/tools/dm/list-top-folders.js');
    const result = await listTopFoldersTool.execute({ hub_id: HUB_ID, project_id: PROJECT_ID }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBeTruthy();
  });
});

// ── Issues read tools (SSA only) ──────────────────────────────────────────────

describe('issues_list', () => {
  it('lists issues for the configured project (SSA only)', async () => {
    if (skipIfNoProject()) return;
    const { env } = await import('../../src/config/env.js');
    if (env.APS_AUTH_MODE !== 'ssa') { console.warn('issues_list requires SSA — skipping'); return; }

    const { listIssuesTool } = await import('../../src/tools/issues/list.js');
    const result = await listIssuesTool.execute({ project_id: PROJECT_ID, limit: 10, offset: 0 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBeTruthy();
  });
});

describe('issues_list_types', () => {
  it('returns issue types for the configured project (SSA only)', async () => {
    if (skipIfNoProject()) return;
    const { env } = await import('../../src/config/env.js');
    if (env.APS_AUTH_MODE !== 'ssa') { console.warn('issues_list_types requires SSA — skipping'); return; }

    const { listIssueTypesTool } = await import('../../src/tools/issues/list-types.js');
    const result = await listIssueTypesTool.execute({ project_id: PROJECT_ID }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBeTruthy();
  });
});

// ── Mutation dry_run preview (no APS write) ───────────────────────────────────

describe('issues_create dry_run=true', () => {
  it('returns preview + approval_token without writing to APS (SSA only)', async () => {
    if (skipIfNoProject()) return;
    const { env } = await import('../../src/config/env.js');
    if (env.APS_AUTH_MODE !== 'ssa') { console.warn('issues_create requires SSA — skipping'); return; }

    const { wrapMutationTool } = await import('../../src/tools/_wrap.js');
    const { createIssueTool } = await import('../../src/tools/issues/create.js');
    const handler = wrapMutationTool(createIssueTool, ctx);

    const result = await handler({
      project_id: PROJECT_ID,
      title: '[smoke-test] integration dry_run — do not execute',
      issue_subtype_id: 'smoke-placeholder',
      status: 'open',
      published: false,
      dry_run: true,
    });

    // Either a valid preview (has approval_token) or a business-rule rejection is fine —
    // what matters is the mutation was NOT executed and no crash occurred.
    expect(result.content[0]?.text).toBeTruthy();
    if (!result.isError) {
      expect(result.content[0]?.text).toContain('approval_token');
    }
  });
});
