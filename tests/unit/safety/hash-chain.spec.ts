import { describe, it, expect } from 'vitest';
import { computeHash, verifyChain } from '../../../src/safety/hash-chain.js';

describe('hash-chain', () => {
  it('returns a sha256: prefixed string', () => {
    const h = computeHash('sha256:genesis', { tool: 'test' });
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const entry = { tool: 'dm.list_hubs', ts: '2026-04-16T00:00:00Z' };
    const h1 = computeHash('sha256:genesis', entry);
    const h2 = computeHash('sha256:genesis', entry);
    expect(h1).toBe(h2);
  });

  it('changes when prevHash differs', () => {
    const entry = { tool: 'foo' };
    const h1 = computeHash('sha256:genesis', entry);
    const h2 = computeHash('sha256:other', entry);
    expect(h1).not.toBe(h2);
  });

  it('changes when entry changes', () => {
    const h1 = computeHash('sha256:genesis', { tool: 'foo' });
    const h2 = computeHash('sha256:genesis', { tool: 'bar' });
    expect(h1).not.toBe(h2);
  });

  describe('verifyChain', () => {
    it('validates a correct chain', () => {
      const h1 = computeHash('sha256:genesis', { tool: 'a', stage: 'executed' });
      const h2 = computeHash(h1, { tool: 'b', stage: 'preview' });

      const result = verifyChain([
        { prev_hash: 'sha256:genesis', this_hash: h1, tool: 'a', stage: 'executed' },
        { prev_hash: h1, this_hash: h2, tool: 'b', stage: 'preview' },
      ]);

      expect(result.valid).toBe(true);
      expect(result.first_invalid_index).toBeUndefined();
    });

    it('detects tampering at index 0', () => {
      const h1 = computeHash('sha256:genesis', { tool: 'a' });
      const h2 = computeHash(h1, { tool: 'b' });

      const result = verifyChain([
        { prev_hash: 'sha256:genesis', this_hash: h1, tool: 'TAMPERED' }, // <-- changed
        { prev_hash: h1, this_hash: h2, tool: 'b' },
      ]);

      expect(result.valid).toBe(false);
      expect(result.first_invalid_index).toBe(0);
    });

    it('detects tampering at index 1', () => {
      const h1 = computeHash('sha256:genesis', { tool: 'a' });
      const h2 = computeHash(h1, { tool: 'b' });

      const result = verifyChain([
        { prev_hash: 'sha256:genesis', this_hash: h1, tool: 'a' },
        { prev_hash: h1, this_hash: h2, tool: 'TAMPERED' }, // <-- changed
      ]);

      expect(result.valid).toBe(false);
      expect(result.first_invalid_index).toBe(1);
    });

    it('validates an empty chain', () => {
      expect(verifyChain([])).toEqual({ valid: true });
    });

    it('detects a deleted entry (gap in prev_hash chain)', () => {
      const h1 = computeHash('sha256:genesis', { tool: 'a' });
      const h2 = computeHash(h1, { tool: 'b' });
      const h3 = computeHash(h2, { tool: 'c' });

      // entry b removed — entry c now has a prev_hash that skips it
      const result = verifyChain([
        { prev_hash: 'sha256:genesis', this_hash: h1, tool: 'a' },
        { prev_hash: h2, this_hash: h3, tool: 'c' },
      ]);

      expect(result.valid).toBe(false);
      expect(result.first_invalid_index).toBe(1);
    });

    it('detects wrong genesis (first entry prev_hash is not genesis sentinel)', () => {
      const fakeGenesis = 'sha256:fake';
      const h1 = computeHash(fakeGenesis, { tool: 'a' });

      const result = verifyChain([
        { prev_hash: fakeGenesis, this_hash: h1, tool: 'a' },
      ]);

      expect(result.valid).toBe(false);
      expect(result.first_invalid_index).toBe(0);
    });
  });
});
