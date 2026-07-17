export class ApsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(`APS API ${status} for ${method} ${url}`);
    this.name = 'ApsApiError';
  }

  isUnauthorized(): boolean {
    return this.status === 401;
  }
  isForbidden(): boolean {
    return this.status === 403;
  }
  isNotFound(): boolean {
    return this.status === 404;
  }
  isConflict(): boolean {
    return this.status === 409;
  }
  isRateLimited(): boolean {
    return this.status === 429;
  }

  toMcpText(): string {
    if (this.status === 200 && this.name === 'ApsGraphQLError') {
      const body = this.body as { graphqlErrors?: Array<{ message: string }> };
      const msgs = body.graphqlErrors?.map((e) => e.message).join('; ') ?? this.message;
      return `AEC Data Model GraphQL error: ${msgs}`;
    }
    if (this.isForbidden()) {
      return (
        `Access denied (403) calling ${this.method} ${this.url}.\n` +
        `Possible causes:\n` +
        `  1. The APS app is not provisioned on this hub — go to Hub Admin → Custom Integrations.\n` +
        `  2. The SSA has not been invited to this project.\n` +
        `  3. The SSA lacks required permissions for this operation.\n` +
        `See docs/AUTH.md for setup steps.`
      );
    }
    if (this.isRateLimited()) {
      return `APS rate limit hit (429) for ${this.method} ${this.url}. The server will retry automatically. If this persists, reduce request frequency.`;
    }
    if (this.isNotFound()) {
      return `Resource not found (404): ${this.method} ${this.url}. Check that the IDs are correct and the resource exists.`;
    }
    return `APS API error ${this.status} for ${this.method} ${this.url}: ${JSON.stringify(this.body)}`;
  }
}

/** Thrown when an APS GraphQL response returns HTTP 200 but includes errors[]. */
export class ApsGraphQLError extends ApsApiError {
  constructor(url: string, errors: Array<{ message: string }>) {
    super(200, 'POST', url, { graphqlErrors: errors });
    this.name = 'ApsGraphQLError';
    this.message = `GraphQL error: ${errors.map((e) => e.message).join('; ')}`;
  }
}

/**
 * A non-GET request did not complete cleanly, so whether APS applied the change is unknown:
 * either no response arrived (timeout/socket error), or the server answered 5xx — which it
 * may have done *after* applying the change. Callers must verify state before retrying; a
 * blind retry can duplicate the mutation.
 */
export class ApsIndeterminateError extends Error {
  constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly reason: string,
    /** Present when the server did answer (5xx); absent for a network failure. */
    public readonly status?: number,
  ) {
    super(
      `${method} ${url} did not complete cleanly (${reason}). Autodesk may or may not have ` +
        `applied this change — verify the current state before retrying, as retrying could ` +
        `duplicate it.`,
    );
    this.name = 'ApsIndeterminateError';
  }
}
