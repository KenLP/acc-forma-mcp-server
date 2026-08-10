import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../../../src/tenancy/crypto.js';

const MASTER_KEY = randomBytes(32).toString('hex');

describe('tenancy/crypto (AES-256-GCM)', () => {
  it('round-trips plaintext through encrypt → decrypt', () => {
    const plaintext = '-----BEGIN PRIVATE KEY-----\nsome-fake-pem-content\n-----END PRIVATE KEY-----';
    const encoded = encryptSecret(plaintext, MASTER_KEY);
    expect(decryptSecret(encoded, MASTER_KEY)).toBe(plaintext);
  });

  it('uses a fresh random IV on every call — encrypting the same plaintext twice differs', () => {
    const plaintext = 'same plaintext both times';
    const a = encryptSecret(plaintext, MASTER_KEY);
    const b = encryptSecret(plaintext, MASTER_KEY);
    expect(a).not.toBe(b);
    const [, ivA] = a.split(':');
    const [, ivB] = b.split(':');
    expect(ivA).not.toBe(ivB);
  });

  it('throws on auth tag mismatch (tampered ciphertext)', () => {
    const encoded = encryptSecret('secret value', MASTER_KEY);
    const [version, iv, tag, ciphertext] = encoded.split(':');
    // Flip a byte in the ciphertext portion — GCM must detect this via the auth tag.
    const tampered = Buffer.from(ciphertext!, 'base64');
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    const tamperedEncoded = [version, iv, tag, tampered.toString('base64')].join(':');
    expect(() => decryptSecret(tamperedEncoded, MASTER_KEY)).toThrow(/authentication failed/);
  });

  it('throws on auth tag mismatch (wrong master key)', () => {
    const encoded = encryptSecret('secret value', MASTER_KEY);
    const wrongKey = randomBytes(32).toString('hex');
    expect(() => decryptSecret(encoded, wrongKey)).toThrow(/authentication failed/);
  });

  it('throws a clear error on an unrecognized format', () => {
    expect(() => decryptSecret('not-the-right-format', MASTER_KEY)).toThrow(/unrecognized ciphertext format/);
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => encryptSecret('x', 'deadbeef')).toThrow(/32 bytes/);
  });
});
