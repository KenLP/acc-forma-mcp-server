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
  vi.doMock('../../../../src/apis/issues.js', () => ({ getIssueUserMe }));
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
    const text = await run({}, { id: 'U1', name: 'Ken Phuc', email: 'ken@example.com', canCreateIssues: true });
    expect(text).toContain('Identity: Ken Phuc <ken@example.com>');
  });

  it('the self-host robot: names it by the email from robot.json instead of "(unknown) <?>"', async () => {
    const text = await run(
      { robotEmail: 'bimlynx-site@x.adskserviceaccount.com' },
      { id: 'ROBOTACCUSERID01', canCreateIssues: false },
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
