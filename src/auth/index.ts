export interface AuthProvider {
  getAccessToken(): Promise<string>;
  getScopes(): string[];
  /** Clear any cached token so the next getAccessToken() fetches fresh. */
  invalidateToken?(): void;
}

export type AuthMode = 'ssa' | '2lo' | '3lo';
