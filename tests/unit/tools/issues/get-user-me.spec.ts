import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '../../../../src/tools/_types.js';
import type { IssueUserProfile } from '../../../../src/apis/issues.js';

/**
 * A service account has no ACC user profile: /users/me answers with an id and permission
 * flags but no name or email. Seen live on the macOS self-host run (2026-11-09), where the
 * tool printed "Identity: (unknown) <?>" — which reads like a failed lookup, not like "this
 * is the robot". execute() is called directly; the wrapper adds nothing to what is tested.
 */
const getIssueUserMe = vi.fn<(auth: unknown, projectId: string) => Promise<IssueUserProfile>>();

async function run(ctxExtra: Partial<ToolContext>, profile: IssueUserProfile): Promise<string> {
  getIssueUserMe.mockResolvedValue(profile);
  vi.doMock('../../../../src/apis/issues.js', async (importActual) => ({
    ...(await importActual<typeof import('../../../../src/apis/issues.js')>()),
    getIssueUserMe,
  }));
  const { getIssueUserMeTool } = await import('../../../../src/tools/issues/get-user-me.js');
  const ctx = { auth: {}, env: {}, ...ctxExtra } as unknown as ToolContext;
  const result = await getIssueUserMeTool.execute({ project_id: 'b.p1' }, ctx);
  return result.content[0]!.text;
}

describe('issues_get_user_me — identity line', () => {
  beforeEach(() => {
    vi.resetModules();
    getIssueUserMe.mockReset();
  });

  it('a person: shows name and email as ACC returns them', async () => {
    const text = await run({}, { id: 'U1', name: 'Ken Phuc', email: 'ken@example.com' });
    expect(text).toContain('Identity: Ken Phuc <ken@example.com>');
  });

  it('the self-host robot: names it by the email from robot.json instead of "(unknown) <?>"', async () => {
    const text = await run(
      { robotEmail: 'bimlynx-site@x.adskserviceaccount.com' },
      { id: 'ROBOTACCUSERID01' },
    );
    expect(text).toContain('Identity: service account (robot) <bimlynx-site@x.adskserviceaccount.com> — no ACC user profile');
    expect(text).not.toContain('(unknown) <?>');
  });

  it('a service account with no robot.json (SSA_* env path): says what it is, without an email', async () => {
    const text = await run({}, { id: 'X' });
    expect(text).toContain('Identity: service account — no ACC user profile');
  });

  it('treats null and empty-string profile fields as absent — the body is passed through as-is', async () => {
    const text = await run(
      { robotEmail: 'r@x.adskserviceaccount.com' },
      { id: 'X', name: null, email: '' } as unknown as IssueUserProfile,
    );
    expect(text).toContain('service account (robot) <r@x.adskserviceaccount.com>');
  });
});

/**
 * The /users/me body as ACC returned it on 2026-11-12 for the self-host robot, a project
 * admin in a test project (trimmed lists, same shape). The old tool read boolean
 * canCreateIssues/canUpdateIssues/canCreateComments fields that do not exist and printed
 * "✗ No" three times — which the 2026-11-09 findings took for a missing grant.
 */
const LIVE_ROBOT_PROFILE = {
  id: 'ROBOTACCUSERID01',
  isProjectAdmin: true,
  permissionLevels: ['read', 'create', 'write'],
  canManageTemplates: true,
  issues: {
    new: {
      permittedActions: ['add_attachment', 'add_comment', 'assign_all', 'clear_assignee', 'delete', 'upsert_pin'],
      permittedStatuses: ['draft', 'open', 'pending', 'in_progress', 'in_review', 'closed'],
      permittedAttributes: ['title', 'description', 'status'],
    },
  },
  allTypes: true,
} as unknown as IssueUserProfile;

describe('issues_get_user_me — permissions from the real response shape', () => {
  beforeEach(() => {
    vi.resetModules();
    getIssueUserMe.mockReset();
  });

  it('a project-admin robot reads as allowed to create, update and comment', async () => {
    const text = await run({ robotEmail: 'r@x.adskserviceaccount.com' }, LIVE_ROBOT_PROFILE);
    expect(text).toContain('Project admin:   ✓ Yes');
    expect(text).toContain('Create issues:   ✓ Yes');
    expect(text).toContain('Update issues:   ✓ Yes');
    expect(text).toContain('Add comments:    ✓ Yes');
  });

  it('a read-only member reads as read-only', async () => {
    const text = await run({}, {
      id: 'V',
      permissionLevels: ['read'],
      issues: { new: { permittedActions: [] } },
    } as IssueUserProfile);
    expect(text).toContain('Create issues:   ✗ No');
    expect(text).toContain('Update issues:   ✗ No');
    expect(text).toContain('Add comments:    ✗ No');
  });
});

describe('issuePermissions (pure)', () => {
  it('maps levels and actions; missing fields mean no grant', async () => {
    const { issuePermissions } = await vi.importActual<typeof import('../../../../src/apis/issues.js')>(
      '../../../../src/apis/issues.js',
    );
    expect(issuePermissions(LIVE_ROBOT_PROFILE)).toEqual({
      projectAdmin: true, createIssues: true, updateIssues: true, addComments: true,
    });
    expect(issuePermissions({})).toEqual({
      projectAdmin: false, createIssues: false, updateIssues: false, addComments: false,
    });
    expect(issuePermissions({ permissionLevels: ['read', 'create'] })).toMatchObject({ createIssues: true, updateIssues: false });
  });
});
