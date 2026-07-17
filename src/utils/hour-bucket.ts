/**
 * The rate-limit bucket key for the current UTC hour.
 *
 * Lives here, with no imports, because both `safety/rate-governance.ts` (which writes
 * counters) and `persistence/db.ts` (which purges stale ones) need it, and importing
 * one from the other would make `persistence → safety → persistence` a cycle. Two
 * copies of this format would silently stop matching and leave counters unpurged.
 */
export function hourBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
}
