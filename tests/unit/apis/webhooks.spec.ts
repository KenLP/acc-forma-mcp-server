import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  parseHookIdFromLocation,
  systemForEvent,
  verifyWebhookSignature,
  WEBHOOK_SYSTEMS,
  DM_EVENTS,
  ISSUE_EVENTS,
} from '../../../src/apis/webhooks.js';

describe('parseHookIdFromLocation', () => {
  // The create endpoint answers 201 with an empty body — the id exists nowhere else.
  it('extracts the hook id from a real Location header', () => {
    expect(
      parseHookIdFromLocation(
        'https://developer.api.autodesk.com/webhooks/v1/systems/data/events/dm.version.added/hooks/0f60f6a0-996c-11e7-abf3-51d68cff984c',
      ),
    ).toBe('0f60f6a0-996c-11e7-abf3-51d68cff984c');
  });

  it('tolerates a trailing slash and surrounding whitespace', () => {
    expect(parseHookIdFromLocation('  https://x/hooks/abc123/  ')).toBe('abc123');
  });

  it('handles an issue event whose name contains dots and a version suffix', () => {
    expect(
      parseHookIdFromLocation(
        'https://developer.api.autodesk.com/webhooks/v1/systems/autodesk.construction.issues/events/issue.created-1.0/hooks/hook-42',
      ),
    ).toBe('hook-42');
  });

  it('returns undefined rather than a wrong id when the header is absent or unparseable', () => {
    expect(parseHookIdFromLocation(null)).toBeUndefined();
    expect(parseHookIdFromLocation('')).toBeUndefined();
    expect(parseHookIdFromLocation('https://developer.api.autodesk.com/webhooks/v1/systems/data')).toBeUndefined();
  });
});

describe('systemForEvent', () => {
  it('routes Data Management events to the data system with folder scope', () => {
    expect(systemForEvent('dm.version.added')).toEqual({
      system: WEBHOOK_SYSTEMS.data,
      scopeKey: 'folder',
    });
  });

  it('routes Issues events to the construction system with project scope', () => {
    expect(systemForEvent('issue.created-1.0')).toEqual({
      system: WEBHOOK_SYSTEMS.issues,
      scopeKey: 'project',
    });
  });

  // The "-1.0" suffix is part of the event name; APS rejects the bare form. Catching it
  // here turns a confusing 404 from Autodesk into an explicit local error.
  it('rejects an issue event missing its mandatory version suffix', () => {
    expect(() => systemForEvent('issue.created')).toThrowError(/Unknown webhook event/);
  });

  it('rejects an unknown event and names the supported set', () => {
    expect(() => systemForEvent('dm.nonsense')).toThrowError(/dm\.version\.added/);
  });

  it('maps every declared event without throwing', () => {
    for (const e of [...DM_EVENTS, ...ISSUE_EVENTS]) {
      expect(() => systemForEvent(e)).not.toThrow();
    }
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-shared-secret';
  const body = JSON.stringify({ version: '1.0', payload: { name: 'Level 3.rvt' } });
  const validSignature =
    'sha1hash=' + createHmac('sha1', secret).update(Buffer.from(body, 'utf-8')).digest('hex');

  it('accepts a signature Autodesk would produce (HMAC-SHA1, sha1hash= prefix)', () => {
    expect(verifyWebhookSignature(body, validSignature, secret)).toBe(true);
  });

  it('accepts the same body passed as a Buffer', () => {
    expect(verifyWebhookSignature(Buffer.from(body, 'utf-8'), validSignature, secret)).toBe(true);
  });

  it('rejects a body altered by even one character', () => {
    expect(verifyWebhookSignature(body.replace('Level 3', 'Level 4'), validSignature, secret)).toBe(
      false,
    );
  });

  it('rejects a signature computed with a different secret', () => {
    const forged =
      'sha1hash=' + createHmac('sha1', 'wrong-secret').update(body).digest('hex');
    expect(verifyWebhookSignature(body, forged, secret)).toBe(false);
  });

  // A SHA-256 digest is a different length; timingSafeEqual throws on length mismatch, so
  // this also proves the length pre-check is in place rather than crashing the caller.
  it('rejects a SHA-256 signature without throwing', () => {
    const sha256 =
      'sha256hash=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, sha256, secret)).toBe(false);
  });

  it('rejects the bare digest when the sha1hash= prefix is missing', () => {
    const bare = createHmac('sha1', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, bare, secret)).toBe(false);
  });

  it('rejects a missing header or empty secret instead of failing open', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, validSignature, '')).toBe(false);
  });

  // Re-serialising the parsed JSON changes key order and whitespace. This is the single
  // most common integration bug, so it is pinned: the signature must NOT survive a round trip.
  it('fails when the body was JSON.parsed and re-stringified with different key order', () => {
    const reordered = JSON.stringify({ payload: { name: 'Level 3.rvt' }, version: '1.0' });
    expect(verifyWebhookSignature(reordered, validSignature, secret)).toBe(false);
  });
});
