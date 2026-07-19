import { describe, it, expect } from 'vitest';
import {
  assertValidCallbackUrl,
  parseCallbackHostAllowlist,
  CallbackUrlError,
} from '../../../src/safety/callback-url.js';

const anyHost = parseCallbackHostAllowlist('*');

describe('assertValidCallbackUrl — transport', () => {
  it('accepts a public https URL', () => {
    const url = assertValidCallbackUrl('https://hooks.example.com/acc/events', anyHost);
    expect(url.hostname).toBe('hooks.example.com');
  });

  it('refuses http — event payloads carry file paths and issue text', () => {
    expect(() => assertValidCallbackUrl('http://hooks.example.com/x', anyHost)).toThrowError(
      /must be https/,
    );
  });

  it('refuses a string that is not an absolute URL', () => {
    expect(() => assertValidCallbackUrl('hooks.example.com/x', anyHost)).toThrowError(
      CallbackUrlError,
    );
  });
});

describe('assertValidCallbackUrl — unreachable hosts', () => {
  // Autodesk's delivery servers cannot reach these. Registering one creates a hook that
  // looks healthy, never fires, and goes inactive after 5 failures — a silent dead end.
  const unreachable = [
    'https://localhost/x',
    'https://LOCALHOST/x',
    'https://api.localhost/x',
    'https://myserver.local/x',
    'https://127.0.0.1/x',
    'https://127.1.2.3/x',
    'https://0.0.0.0/x',
    'https://10.0.0.5/x',
    'https://192.168.1.10/x',
    'https://172.16.0.1/x',
    'https://172.31.255.254/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://[fe80::1]/x',
    'https://[fd00::1]/x',
  ];

  for (const url of unreachable) {
    it(`refuses ${url}`, () => {
      expect(() => assertValidCallbackUrl(url, anyHost)).toThrowError(
        /loopback, private, or link-local/,
      );
    });
  }

  // 172.32.x is outside the private 172.16–172.31 range, and 11.x is public space.
  it('does not over-block public addresses that merely look private', () => {
    expect(() => assertValidCallbackUrl('https://172.32.0.1/x', anyHost)).not.toThrow();
    expect(() => assertValidCallbackUrl('https://11.0.0.1/x', anyHost)).not.toThrow();
  });
});

describe('assertValidCallbackUrl — host allow-list', () => {
  it('permits any public host when the list is *', () => {
    expect(() => assertValidCallbackUrl('https://anything.example.org/x', anyHost)).not.toThrow();
  });

  it('matches an exact host and rejects everything else', () => {
    const list = parseCallbackHostAllowlist('hooks.example.com, n8n.acme.io');
    expect(() => assertValidCallbackUrl('https://hooks.example.com/x', list)).not.toThrow();
    expect(() => assertValidCallbackUrl('https://n8n.acme.io/x', list)).not.toThrow();
    expect(() => assertValidCallbackUrl('https://evil.example.com/x', list)).toThrowError(
      /FORMA_ALLOWED_CALLBACK_HOSTS/,
    );
  });

  it('treats a leading dot as a subdomain wildcard, including the bare domain', () => {
    const list = parseCallbackHostAllowlist('.example.com');
    expect(() => assertValidCallbackUrl('https://hooks.example.com/x', list)).not.toThrow();
    expect(() => assertValidCallbackUrl('https://deep.hooks.example.com/x', list)).not.toThrow();
    expect(() => assertValidCallbackUrl('https://example.com/x', list)).not.toThrow();
  });

  // "notexample.com" must not match an ".example.com" entry via a naive endsWith.
  it('does not let a suffix entry match an unrelated domain that merely ends with it', () => {
    const list = parseCallbackHostAllowlist('.example.com');
    expect(() => assertValidCallbackUrl('https://notexample.com/x', list)).toThrowError(
      CallbackUrlError,
    );
  });

  it('is case-insensitive on the host', () => {
    const list = parseCallbackHostAllowlist('Hooks.Example.COM');
    expect(() => assertValidCallbackUrl('https://hooks.example.com/x', list)).not.toThrow();
  });
});
