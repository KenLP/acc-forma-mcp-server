import { describe, it, expect } from 'vitest';
import { stripBPrefix, addBPrefix, normalizeProjectId } from '../../../src/utils/project-id.js';

describe('project-id utils', () => {
  describe('stripBPrefix', () => {
    it('removes b. prefix', () => {
      expect(stripBPrefix('b.abc-123')).toBe('abc-123');
    });
    it('no-ops when prefix is absent', () => {
      expect(stripBPrefix('abc-123')).toBe('abc-123');
    });
    it('only removes leading b.', () => {
      expect(stripBPrefix('b.b.abc')).toBe('b.abc');
    });
  });

  describe('addBPrefix', () => {
    it('adds prefix when absent', () => {
      expect(addBPrefix('abc-123')).toBe('b.abc-123');
    });
    it('no-ops when prefix already present', () => {
      expect(addBPrefix('b.abc-123')).toBe('b.abc-123');
    });
  });

  describe('normalizeProjectId', () => {
    it('handles bare UUID', () => {
      expect(normalizeProjectId('abc-123')).toEqual({
        withPrefix: 'b.abc-123',
        bare: 'abc-123',
      });
    });
    it('handles prefixed UUID', () => {
      expect(normalizeProjectId('b.abc-123')).toEqual({
        withPrefix: 'b.abc-123',
        bare: 'abc-123',
      });
    });
  });
});
