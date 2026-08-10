import { env } from '../config/env.js';
import { getDb } from './db.js';

/**
 * `tenantId` isolates counters per remote tenant. `bucketKey` is the same
 * `${toolName}::${projectId}::${bucket}` string local mode has always used (see
 * src/safety/rate-governance.ts) — tenant isolation is layered on as a separate
 * dimension here, not folded into that string, so a pre-existing local SQLite db's
 * `bucket_key` values never change shape.
 */
export interface RateStore {
  increment(tenantId: string, bucketKey: string, hourBucket: string): number;
  pruneStale(currentHourBucket: string): void;
}

// ---- Memory backend --------------------------------------------------------

class MemoryRateStore implements RateStore {
  private readonly counters = new Map<string, number>();

  private key(tenantId: string, bucketKey: string): string {
    return `${tenantId}::${bucketKey}`;
  }

  increment(tenantId: string, bucketKey: string): number {
    const key = this.key(tenantId, bucketKey);
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return count;
  }

  pruneStale(currentHourBucket: string): void {
    for (const key of this.counters.keys()) {
      if (!key.endsWith(currentHourBucket)) this.counters.delete(key);
    }
  }
}

// ---- SQLite backend --------------------------------------------------------

type RateRow = { count: number };

class SqliteRateStore implements RateStore {
  increment(tenantId: string, bucketKey: string, hourBucket: string): number {
    getDb().prepare(
      'INSERT INTO rate_counters (tenant_id,bucket_key,count,hour_bucket) VALUES (?,?,1,?) ' +
      'ON CONFLICT(tenant_id,bucket_key) DO UPDATE SET count = count + 1',
    ).run(tenantId, bucketKey, hourBucket);

    const row = getDb()
      .prepare('SELECT count FROM rate_counters WHERE tenant_id=? AND bucket_key=?')
      .get(tenantId, bucketKey) as RateRow | undefined;
    return row?.count ?? 1;
  }

  pruneStale(currentHourBucket: string): void {
    getDb()
      .prepare('DELETE FROM rate_counters WHERE hour_bucket != ?')
      .run(currentHourBucket);
  }
}

// ---- Factory ---------------------------------------------------------------

let _store: RateStore | null = null;

export function getRateStore(): RateStore {
  if (!_store) {
    _store = env.FORMA_PERSISTENCE_MODE === 'sqlite'
      ? new SqliteRateStore()
      : new MemoryRateStore();
  }
  return _store;
}

export function _resetRateStore(): void { _store = null; }
