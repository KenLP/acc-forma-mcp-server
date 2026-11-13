import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real better-sqlite3, same pattern as token-store-consume.spec.ts. reserve() must be an
// atomic claim on (tenant_id, idem_key): across processes sharing state.db, exactly one
// caller gets null (holds the key) and every other caller sees the in-flight record.

let dir: string;
let closeDb: (() => void) | undefined;

describe('SqliteIdempotencyStore#reserve', () => {
  beforeEach(() => {
    vi.resetModules();
    closeDb = undefined;
    dir = mkdtempSync(join(tmpdir(), 'forma-idem-reserve-'));
  });

  afterEach(() => {
    closeDb?.();
    rmSync(dir, { recursive: true, force: true });
  });

  async function load(): Promise<typeof import('../../../src/persistence/idempotency-store.js')> {
    const env = { FORMA_PERSISTENCE_MODE: 'sqlite', FORMA_DB_PATH: join(dir, 'state.db'), FORMA_APPROVAL_TOKEN_TTL: 300 };
    vi.doMock('../../../src/config/env.js', () => ({ env }));
    const db = await import('../../../src/persistence/db.js');
    const store = await import('../../../src/persistence/idempotency-store.js');
    db._resetDb();
    store._resetIdempotencyStore();
    closeDb = () => {
      store._resetIdempotencyStore();
      db._resetDb();
    };
    return store;
  }

  const OP = { toolName: 'issues_create', payloadHash: 'a'.repeat(64) };
  const RESULT = { content: [{ type: 'text' as const, text: 'created' }] };

  it('lets exactly one caller hold a key; the other sees it in flight', async () => {
    const store = (await load()).getIdempotencyStore();
    const later = Date.now() + 60_000;

    expect(store.reserve('', 'k', OP, later)).toBeNull();
    expect(store.reserve('', 'k', OP, later)).toEqual({ ...OP, result: null });
  });

  it('a completed key returns its stored result instead of a new claim', async () => {
    const store = (await load()).getIdempotencyStore();
    const later = Date.now() + 60_000;

    store.reserve('', 'k', OP, later);
    store.store('', 'k', { ...OP, result: RESULT }, later);
    expect(store.reserve('', 'k', OP, later)).toEqual({ ...OP, result: RESULT });
  });

  it('release frees the key; an expired reservation is reclaimable', async () => {
    const store = (await load()).getIdempotencyStore();

    store.reserve('', 'k', OP, Date.now() + 60_000);
    store.release('', 'k');
    expect(store.reserve('', 'k', OP, Date.now() - 1)).toBeNull();
    expect(store.reserve('', 'k', OP, Date.now() + 60_000)).toBeNull();
  });

  it('keys are per tenant', async () => {
    const store = (await load()).getIdempotencyStore();
    const later = Date.now() + 60_000;

    expect(store.reserve('tenant-a', 'k', OP, later)).toBeNull();
    expect(store.reserve('tenant-b', 'k', OP, later)).toBeNull();
  });
});
