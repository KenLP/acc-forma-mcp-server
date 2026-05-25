interface CachedToken {
  access_token: string;
  expires_at: number; // unix ms
}

/** In-memory token cache with expiry buffer */
export class TokenCache {
  private cache: CachedToken | null = null;
  private readonly bufferMs = 60_000; // refresh 60s before actual expiry

  isValid(): boolean {
    return this.cache !== null && Date.now() < this.cache.expires_at - this.bufferMs;
  }

  get(): string | null {
    return this.isValid() ? (this.cache?.access_token ?? null) : null;
  }

  set(token: string, expiresInSeconds: number): void {
    this.cache = {
      access_token: token,
      expires_at: Date.now() + expiresInSeconds * 1000,
    };
  }

  invalidate(): void {
    this.cache = null;
  }
}
