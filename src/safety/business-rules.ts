export class BusinessRuleError extends Error {
  constructor(
    public readonly rule: string,
    detail: string,
  ) {
    super(`Business rule "${rule}" failed: ${detail}`);
    this.name = 'BusinessRuleError';
  }
}

export interface ValidationContext {
  projectId?: string;
}

type Validator = (
  input: Record<string, unknown>,
  ctx: ValidationContext,
) => Promise<{ passed: string[] }>;

// Registry keyed by tool name
const registry = new Map<string, Validator>();

/** Register a business-rule validator for a specific tool */
export function registerValidator<T extends Record<string, unknown>>(
  toolName: string,
  validator: (input: T, ctx: ValidationContext) => Promise<{ passed: string[] }>,
): void {
  registry.set(toolName, validator as Validator);
}

/**
 * Run all registered validators for a tool.
 * Throws BusinessRuleError on first failure.
 * Returns list of passed rule names.
 */
export async function runBusinessRules(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ValidationContext,
): Promise<string[]> {
  const validator = registry.get(toolName);
  if (!validator) return [];
  const { passed } = await validator(input, ctx);
  return passed;
}
