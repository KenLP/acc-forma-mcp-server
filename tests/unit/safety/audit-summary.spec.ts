import { describe, it, expect } from 'vitest';
import { summarizeForAudit } from '../../../src/safety/audit-summary.js';

describe('summarizeForAudit', () => {
  // Real shape of issues_create's structuredContent (`{ issue }`, see
  // src/tools/issues/create.ts) — the audit log used to write this verbatim, which is
  // exactly what PRIVACY.md's "short output summary" promise says it does not do.
  const ISSUES_CREATE_STRUCTURED_CONTENT = {
    issue: {
      id: 'a1b2c3d4-0000-0000-0000-000000000001',
      displayId: 42,
      title: 'Fire door propped open on level 3 — confidential tenant complaint',
      status: 'open',
      issueTypeId: 'type-001',
      issueSubtypeId: 'subtype-001',
      published: true,
      description: 'Reported by facilities manager; tenant name and unit number attached.',
      customAttributes: [{ attributeDefinitionId: 'attr-1', value: 'Contains PII' }],
      linkedDocuments: [{ type: 'TwoDVectorPushpin', urn: 'urn:adsk.wipprod:dm.lineage:xyz' }],
      locationId: 'loc-001',
      rootCauseId: 'cause-001',
      createdBy: 'user-001',
      createdAt: '2026-08-12T00:00:00Z',
    },
  };

  it('keeps resource identifiers and status from the real issues_create shape', () => {
    const summary = summarizeForAudit(ISSUES_CREATE_STRUCTURED_CONTENT) as {
      issue: Record<string, unknown>;
    };

    expect(summary.issue['id']).toBe('a1b2c3d4-0000-0000-0000-000000000001');
    expect(summary.issue['displayId']).toBe(42);
    expect(summary.issue['status']).toBe('open');
    expect(summary.issue['published']).toBe(true);
    expect(summary.issue['issueTypeId']).toBe('type-001');
    expect(summary.issue['issueSubtypeId']).toBe('subtype-001');
    expect(summary.issue['locationId']).toBe('loc-001');
    expect(summary.issue['rootCauseId']).toBe('cause-001');
  });

  it('drops free text and business content from the real issues_create shape', () => {
    const summary = summarizeForAudit(ISSUES_CREATE_STRUCTURED_CONTENT) as {
      issue: Record<string, unknown>;
    };

    expect(summary.issue['title']).toBeUndefined();
    expect(summary.issue['description']).toBeUndefined();
    expect(summary.issue['customAttributes']).toBeUndefined();
    expect(summary.issue['linkedDocuments']).toBeUndefined();
    expect(summary.issue['createdBy']).toBeUndefined();
    expect(summary.issue['createdAt']).toBeUndefined();

    // The whole point: none of the tenant-identifying free text leaks into the serialized
    // summary, even buried inside a nested field.
    expect(JSON.stringify(summary)).not.toContain('confidential');
    expect(JSON.stringify(summary)).not.toContain('tenant');
    expect(JSON.stringify(summary)).not.toContain('PII');
  });

  it('records how many fields were dropped, for a human reading the log later', () => {
    const summary = summarizeForAudit(ISSUES_CREATE_STRUCTURED_CONTENT) as {
      issue: Record<string, unknown>;
    };
    expect(summary.issue['_omitted']).toBeGreaterThan(0);
  });

  it('unwraps only one level — a nested object under a dropped key does not surface', () => {
    // customAttributes is an array (already dropped by the array rule); linkedDocuments too.
    // Verify a plain nested object two levels deep under a non-kept key is also dropped,
    // not partially walked.
    const twoLevelsDeep = {
      issue: {
        id: 'issue-1',
        status: 'open',
        assignedToDetails: { name: 'Jane Doe', email: 'jane@example.com' },
      },
    };
    const summary = summarizeForAudit(twoLevelsDeep) as { issue: Record<string, unknown> };
    expect(summary.issue['id']).toBe('issue-1');
    expect(summary.issue['assignedToDetails']).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('Jane Doe');
  });

  it('drops a nested array under a non-kept key entirely (never inlines its contents)', () => {
    const summary = summarizeForAudit({
      id: 'issue-1',
      attachments: [{ id: 'a1', fileName: 'secret.pdf' }, { id: 'a2' }],
    }) as Record<string, unknown>;
    expect(summary['id']).toBe('issue-1');
    expect(summary['attachments']).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('secret.pdf');
  });

  it('handles null', () => {
    expect(summarizeForAudit(null)).toBeNull();
  });

  it('handles undefined', () => {
    expect(summarizeForAudit(undefined)).toBeUndefined();
  });

  it('handles a scalar (string)', () => {
    expect(summarizeForAudit('just a string')).toBe('just a string');
  });

  it('handles a scalar (number)', () => {
    expect(summarizeForAudit(42)).toBe(42);
  });

  it('handles a top-level array', () => {
    const summary = summarizeForAudit([{ id: 'a1', title: 'secret' }, { id: 'a2' }]) as {
      _array_length: number;
    };
    expect(summary._array_length).toBe(2);
  });

  it('keeps *Id and *Count suffixed keys generically, not just the hardcoded exact ones', () => {
    const summary = summarizeForAudit({
      hookId: 'hook-1',
      entryCount: 7,
      callbackUrl: 'https://example.com/hook',
    }) as Record<string, unknown>;
    expect(summary['hookId']).toBe('hook-1');
    expect(summary['entryCount']).toBe(7);
    expect(summary['callbackUrl']).toBeUndefined();
  });

  it('flat (non-wrapped) structuredContent still keeps identifiers at the top level', () => {
    // e.g. reviews_create / reviews_transition: { review: {...} } is wrapped, but a tool
    // could also return a flat shape directly.
    const summary = summarizeForAudit({ id: 'review-1', status: 'in_review', comment: 'looks good' }) as Record<
      string,
      unknown
    >;
    expect(summary['id']).toBe('review-1');
    expect(summary['status']).toBe('in_review');
    expect(summary['comment']).toBeUndefined();
  });
});
