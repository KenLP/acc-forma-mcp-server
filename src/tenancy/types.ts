/** A provisioned remote-mode tenant (Robot-per-Tenant SSA — see docs/specs/SPEC_remote-mcp.md §2). */
export interface TenantRecord {
  id: string;
  name: string;
  robotEmail: string;
  serviceAccountId: string;
  keyId: string;
  /** AES-256-GCM ciphertext (crypto.ts format) of the robot's RS256 private key PEM. */
  privateKeyCiphertext: string;
  /** sha256 hex of the bearer key. The live bearer key is never stored — see robot-store.ts. */
  bearerKeyHash: string;
  createdAt: string;
  disabled: boolean;
}
