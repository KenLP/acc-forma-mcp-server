import { describe, it, expect } from 'vitest';
import { validateCategoryName } from '../../../src/apis/aecdm.js';

describe('validateCategoryName', () => {
  it('accepts standard Revit category names', () => {
    expect(() => validateCategoryName('Walls')).not.toThrow();
    expect(() => validateCategoryName('Structural Columns')).not.toThrow();
    expect(() => validateCategoryName('Pipe Fittings')).not.toThrow();
    expect(() => validateCategoryName('Mechanical Equipment')).not.toThrow();
  });

  it('accepts names with hyphens, slashes, and parens', () => {
    expect(() => validateCategoryName('Duct/Pipe')).not.toThrow();
    expect(() => validateCategoryName('Fire-Rated Walls')).not.toThrow();
    expect(() => validateCategoryName('Equipment (Generic)')).not.toThrow();
  });

  it('rejects a single-quote (filter injection vector)', () => {
    expect(() => validateCategoryName("Walls' OR '1'='1")).toThrow(/Invalid category name/);
    expect(() => validateCategoryName("test'injection")).toThrow(/Invalid category name/);
  });

  it('rejects other special characters used in filter DSL', () => {
    expect(() => validateCategoryName('Walls==true')).toThrow(/Invalid category name/);
    expect(() => validateCategoryName('Walls; DROP')).toThrow(/Invalid category name/);
    expect(() => validateCategoryName('<script>')).toThrow(/Invalid category name/);
  });
});
