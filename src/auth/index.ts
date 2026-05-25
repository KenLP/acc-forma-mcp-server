export interface AuthProvider {
  getAccessToken(): Promise<string>;
  getScopes(): string[];
}

export type AuthMode = 'ssa' | '2lo' | '3lo';
