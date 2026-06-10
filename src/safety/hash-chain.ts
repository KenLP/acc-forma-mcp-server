import { createHash } from 'node:crypto';

/** Compute hash(prevHash + canonical JSON of entry) */
export function computeHash(prevHash: string, entry: Record<string, unknown>): string {
  // Sort entry keys for determinism, then prepend prevHash
  const sortedEntry = Object.fromEntries(
    Object.keys(entry)
      .sort()
      .map((k) => [k, entry[k]]),
  );
  const canonical = JSON.stringify({ prevHash, ...sortedEntry });
  return `sha256:${createHash('sha256').update(canonical, 'utf-8').digest('hex')}`;
}

export interface ChainEntry extends Record<string, unknown> {
  prev_hash: string;
  this_hash: string;
}

/** Verify the integrity of a chain of audit entries */
export function verifyChain(entries: ChainEntry[]): {
  valid: boolean;
  first_invalid_index?: number;
} {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const { prev_hash, this_hash, ...rest } = entry;

    // Adjacency: prev_hash must point to the previous entry's this_hash
    // (or the genesis sentinel for the first entry). Catches deleted lines.
    const expectedPrevHash = i === 0 ? 'sha256:genesis' : entries[i - 1]!.this_hash;
    if (prev_hash !== expectedPrevHash) {
      return { valid: false, first_invalid_index: i };
    }

    const expected = computeHash(prev_hash, rest);
    if (expected !== this_hash) {
      return { valid: false, first_invalid_index: i };
    }
  }
  return { valid: true };
}
