import { describe, it, expect } from 'vitest';
import { toServiceAccountName, SSA_ADMIN_SCOPES } from '../../../src/apis/ssa-admin.js';

describe('toServiceAccountName', () => {
  it('keeps an already-valid slug unchanged', () => {
    expect(toServiceAccountName('acme-corp')).toBe('acme-corp');
  });

  it('slugifies "Acme Corp" to "acme-corp"', () => {
    expect(toServiceAccountName('Acme Corp')).toBe('acme-corp');
  });

  it('turns Vietnamese diacritics and other non-alphanumeric characters into dashes without being empty', () => {
    const result = toServiceAccountName('Công ty Việt Nam!');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[a-z0-9-]+$/);
    // every diacritic/space/punctuation run collapses to a single dash, none survive raw
    expect(result).not.toMatch(/[^a-z0-9-]/);
  });

  it('pads a short name up to the 5-character minimum', () => {
    const result = toServiceAccountName('AB');
    expect(result.length).toBeGreaterThanOrEqual(5);
    expect(result).toMatch(/^[a-z0-9-]+$/);
    expect(result.startsWith('ab')).toBe(true);
  });

  it('truncates a name longer than 100 characters', () => {
    const result = toServiceAccountName('a'.repeat(150));
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('throws when nothing alphanumeric survives slugification', () => {
    expect(() => toServiceAccountName('!!!@@@###...')).toThrowError(
      /no alphanumeric characters/,
    );
  });
});

describe('SSA_ADMIN_SCOPES', () => {
  it('contains exactly the four distinct service-account scopes, verbatim', () => {
    expect(SSA_ADMIN_SCOPES).toEqual([
      'application:service_account:read',
      'application:service_account:write',
      'application:service_account_key:read',
      'application:service_account_key:write',
    ]);
  });
});
