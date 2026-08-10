import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * AES-256-GCM encryption for tenant robot private keys at rest.
 *
 * No config/env.js import here (or anywhere under src/tenancy/) — the master key always
 * arrives as an explicit parameter so this module stays testable without env.ts's
 * throw-at-import behavior.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // GCM standard nonce size
const FORMAT_VERSION = 'v1';

function keyFromHex(masterKeyHex: string): Buffer {
  const key = Buffer.from(masterKeyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `encryptSecret/decryptSecret: master key must decode to 32 bytes (64 hex chars), got ${key.length} bytes`,
    );
  }
  return key;
}

/**
 * Encrypts `plaintext` with AES-256-GCM. Output is self-contained:
 * `v1:<iv base64>:<authTag base64>:<ciphertext base64>`. A fresh random IV is
 * generated on every call, so encrypting the same plaintext twice yields different output.
 */
export function encryptSecret(plaintext: string, masterKeyHex: string): string {
  const key = keyFromHex(masterKeyHex);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Reverses encryptSecret(). Throws if the format is unrecognized or the auth tag doesn't verify. */
export function decryptSecret(encoded: string, masterKeyHex: string): string {
  const key = keyFromHex(masterKeyHex);
  const parts = encoded.split(':');
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (parts.length !== 4 || version !== FORMAT_VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error(
      `decryptSecret: unrecognized ciphertext format (expected "v1:<iv>:<tag>:<ciphertext>")`,
    );
  }

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error(
      `decryptSecret: authentication failed — ciphertext was tampered with or the master key is wrong (${(err as Error).message})`,
    );
  }
}
