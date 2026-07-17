import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apsRequest } from '../../../src/http/client.js';
import { ApsApiError, ApsIndeterminateError } from '../../../src/http/errors.js';
import type { AuthProvider } from '../../../src/auth/index.js';

// Finding #3: retrying a 5xx on a non-idempotent mutation (POST/PATCH/etc.) can duplicate
// the change if APS actually applied it before failing. These tests pin the resulting policy:
//   - GET: always safe to retry on 5xx/network-failure (nothing was mutated) -> ApsApiError
//     once retries are exhausted (a GET failure is definite, never "unknown").
//   - non-GET + 5xx: NOT retried unless the caller opts in via retryOn5xx (documented-idempotent
//     endpoints only, e.g. Model Properties diffs:batch-status) -> ApsIndeterminateError, because
//     APS may have applied the change before answering 5xx.
//   - non-GET + retryOn5xx:true + 5xx: retried, then ApsApiError once exhausted (caller already
//     confirmed the endpoint is idempotent, so no "may duplicate" warning is needed).
//   - non-GET + network failure (no response at all): outcome is unknown -> ApsIndeterminateError,
//     never retried blind.
//   - non-GET + 4xx: ApsApiError, never retried (the request was definitively rejected).
//   - 429 and 401: always retried regardless of method (the request was rejected up front, never
//     applied).

function makeAuth(): AuthProvider {
  return {
    getAccessToken: (): Promise<string> => Promise.resolve('tok'),
    getScopes: (): string[] => [],
  };
}

function jsonResponse(status: number, body: unknown = { error: 'boom' }): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('apsRequest retry policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('GET + 5xx: retries then throws ApsApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const promise = apsRequest(makeAuth(), '/foo', { method: 'GET' });
    const assertion = expect(promise).rejects.toBeInstanceOf(ApsApiError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('POST + 5xx: does NOT retry (exactly one call), throws ApsIndeterminateError (outcome unknown, not a definite failure)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const err = await apsRequest(makeAuth(), '/foo', { method: 'POST', body: { a: 1 } }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApsIndeterminateError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET + 5xx: retries then throws ApsApiError (GET never mutates, so a definite failure)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const promise = apsRequest(makeAuth(), '/foo', { method: 'GET' });
    const assertion = expect(promise).rejects.toBeInstanceOf(ApsApiError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('POST + retryOn5xx:true + 5xx: DOES retry, throws ApsApiError (caller confirmed idempotent, no duplicate-mutation warning needed)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const promise = apsRequest(makeAuth(), '/foo', {
      method: 'POST',
      body: { a: 1 },
      retryOn5xx: true,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(ApsApiError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('POST + 4xx: throws ApsApiError, exactly one call (client error is definite, never retried)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400));
    vi.stubGlobal('fetch', fetchMock);

    const err = await apsRequest(makeAuth(), '/foo', { method: 'POST', body: { a: 1 } }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApsApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POST + network failure: throws ApsIndeterminateError, exactly one call, message mentions outcome/verify', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await apsRequest(makeAuth(), '/foo', {
      method: 'POST',
      body: { a: 1 },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApsIndeterminateError);
    expect((err as ApsIndeterminateError).message).toMatch(/may or may not/i);
    expect((err as ApsIndeterminateError).status).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POST + 5xx: ApsIndeterminateError message mentions "may or may not" and carries the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const err = await apsRequest(makeAuth(), '/foo', { method: 'POST', body: { a: 1 } }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApsIndeterminateError);
    expect((err as ApsIndeterminateError).message).toMatch(/may or may not/i);
    expect((err as ApsIndeterminateError).status).toBe(503);
  });

  it('GET + network failure: retries then throws the original error (not ApsIndeterminateError)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = apsRequest(makeAuth(), '/foo', { method: 'GET' });
    const assertion = expect(promise).rejects.toThrow('The operation was aborted');
    await vi.runAllTimersAsync();
    await assertion;

    const err = await promise.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApsIndeterminateError);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('POST + 429: still retries (429 was rejected up front, safe for any method)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    vi.stubGlobal('fetch', fetchMock);

    const promise = apsRequest(makeAuth(), '/foo', { method: 'POST', body: { a: 1 } });
    const assertion = expect(promise).rejects.toBeInstanceOf(ApsApiError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
