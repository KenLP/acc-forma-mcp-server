import { describe, it, expect } from 'vitest';
import { assertAllowedUrl, DisallowedUrlError } from '../../../src/utils/url-guard.js';

describe('assertAllowedUrl', () => {
  it('allows an exact host match and returns a URL', () => {
    const result = assertAllowedUrl('https://developer.api.autodesk.com/x/y', {
      exactHosts: ['developer.api.autodesk.com'],
    });
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe('developer.api.autodesk.com');
  });

  it('rejects a host outside the declared endpoint set', () => {
    expect(() =>
      assertAllowedUrl('https://evil.com/x', { exactHosts: ['developer.api.autodesk.com'] }),
    ).toThrow(DisallowedUrlError);
  });

  it('rejects non-https protocols even for an otherwise-allowed host', () => {
    expect(() =>
      assertAllowedUrl('http://developer.api.autodesk.com/x', {
        exactHosts: ['developer.api.autodesk.com'],
      }),
    ).toThrow(DisallowedUrlError);
  });

  it('allows a host matching a declared suffix', () => {
    const result = assertAllowedUrl('https://bucket.s3.us-east-1.amazonaws.com/file', {
      hostSuffixes: ['.amazonaws.com'],
    });
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe('bucket.s3.us-east-1.amazonaws.com');
  });

  it('rejects a host that merely contains the suffix without the leading dot boundary', () => {
    expect(() =>
      assertAllowedUrl('https://evil-amazonaws.com/x', { hostSuffixes: ['.amazonaws.com'] }),
    ).toThrow(DisallowedUrlError);
  });

  it('rejects a string that is not a valid absolute URL', () => {
    expect(() =>
      assertAllowedUrl('not a url', { exactHosts: ['developer.api.autodesk.com'] }),
    ).toThrow(DisallowedUrlError);
  });
});
