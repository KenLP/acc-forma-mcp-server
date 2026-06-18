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
    it('extracts GUID from workspace URN (urn:adsk.workspace:env.project:GUID)', () => {
      expect(
        stripBPrefix('urn:adsk.workspace:prod.project:80424913-8ca5-4e39-80b0-ebf00ad69385'),
      ).toBe('80424913-8ca5-4e39-80b0-ebf00ad69385');
    });
    it('extracts last segment from any urn: prefixed id', () => {
      expect(stripBPrefix('urn:adsk.workspace:staging.project:abc-def-123')).toBe('abc-def-123');
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
