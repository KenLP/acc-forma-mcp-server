import { describe, it, expect } from 'vitest';
import { ApsGraphQLError, ApsApiError } from '../../../src/http/errors.js';

describe('ApsGraphQLError', () => {
  it('is an instance of ApsApiError (caught by _wrap.ts error handler)', () => {
    const err = new ApsGraphQLError('https://example.com/graphql', [{ message: 'not found' }]);
    expect(err).toBeInstanceOf(ApsApiError);
  });

  it('has status 200 and name ApsGraphQLError', () => {
    const err = new ApsGraphQLError('https://example.com/graphql', [{ message: 'field error' }]);
    expect(err.status).toBe(200);
    expect(err.name).toBe('ApsGraphQLError');
  });

  it('toMcpText returns a human-readable GraphQL message', () => {
    const err = new ApsGraphQLError('https://example.com/graphql', [
      { message: 'Element not found' },
      { message: 'Permission denied' },
    ]);
    const text = err.toMcpText();
    expect(text).toContain('GraphQL error');
    expect(text).toContain('Element not found');
    expect(text).toContain('Permission denied');
  });

  it('message joins multiple errors with semicolons', () => {
    const err = new ApsGraphQLError('https://example.com/graphql', [
      { message: 'err1' },
      { message: 'err2' },
    ]);
    expect(err.message).toBe('GraphQL error: err1; err2');
  });
});
