import { env } from '../config/env.js';

export class ReadonlyModeError extends Error {
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is a mutation but the server is in read-only mode ` +
        `(FORMA_READONLY=true or FORMA_MUTATION_MODE=readonly). ` +
        `Set FORMA_READONLY=false and FORMA_MUTATION_MODE=preview_required to enable writes.`,
    );
    this.name = 'ReadonlyModeError';
  }
}

export function checkNotReadonly(toolName: string): void {
  if (env.FORMA_READONLY || env.FORMA_MUTATION_MODE === 'readonly') {
    throw new ReadonlyModeError(toolName);
  }
}
