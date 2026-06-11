import { env } from '../config/env.js';
import { getDb } from './db.js';

export interface RateStore {
  increment(bucketKey: string, hourBucket: string): number;
  pruneStale(currentHourBucket: string): void;
}

// ---- Memory backend --------------------------------------------------------

class MemoryRateStore implements RateStore {
  private readonly counters = new Map<string, number>();

  increment(bucketKey: string): number {
    const count = (this.counters.get(bucketKey) ?? 0) + 1;
    this.counters.set(bucketKey, count);
    return count;
  }

  pruneStale(currentHourBucket: string): void {
    for (const key of this.counters.keys()) {
      if (!key.endsWith(currentHourBucket)) this.counters.delete(key);
    }
  }
}

// ---- SQLite backend --------------------------------------------------------

type RateRow = { bucket_key: string; count: number };

class SqliteRateStore implements RateStore {
  increment(bucketKey: string, hourBucket: string): number {
    getDb().prepare(
      'INSERT INTO rate_counters (bucket_key,count,hour_bucket) VALUES (?,1,?) ' +
      'ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1',
    ).run(bucketKey, hourBucket);

    const row = getDb()
      .prepare('SELECT count FROM rate_counters WHERE bucket_key=?')
      .get(bucketKey) as RateRow | undefined;
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
