import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decryptString,
  deriveKek,
  encryptString,
  ENC_PREFIX,
  generateDek,
  isEncrypted,
  newSalt,
  unwrapDek,
  wrapDek,
} from './crypto';

// Small iteration count keeps PBKDF2 fast in tests; production uses the default.
const ITERS = 1000;

describe('base64 round-trip', () => {
  it('preserves arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('encryptString / decryptString', () => {
  it('round-trips and marks the envelope', async () => {
    const dek = await generateDek();
    const ct = await encryptString(dek, 'sk-secret-token');
    expect(isEncrypted(ct)).toBe(true);
    expect(ct.startsWith(ENC_PREFIX)).toBe(true);
    expect(ct).not.toContain('sk-secret-token');
    expect(await decryptString(dek, ct)).toBe('sk-secret-token');
  });

  it('produces different ciphertext each time (random IV)', async () => {
    const dek = await generateDek();
    expect(await encryptString(dek, 'x')).not.toBe(await encryptString(dek, 'x'));
  });

  it('fails to decrypt under a different key (authenticated)', async () => {
    const ct = await encryptString(await generateDek(), 'x');
    await expect(decryptString(await generateDek(), ct)).rejects.toBeTruthy();
  });

  it('rejects a tampered envelope', async () => {
    const dek = await generateDek();
    const ct = await encryptString(dek, 'hello world');
    const tampered = ct.slice(0, -2) + (ct.endsWith('A') ? 'B' : 'A') + '=';
    await expect(decryptString(dek, tampered)).rejects.toBeTruthy();
  });

  it('isEncrypted is false for plaintext', () => {
    expect(isEncrypted('plain value')).toBe(false);
  });
});

describe('DEK wrapping under a passphrase-derived KEK', () => {
  it('unwraps with the correct passphrase and decrypts data', async () => {
    const salt = newSalt();
    const dek = await generateDek();
    const kek = await deriveKek('correct horse battery staple', salt, ITERS);
    const wrapped = await wrapDek(kek, dek);

    const ct = await encryptString(dek, 'enterprise data');

    // Re-derive from passphrase + salt (simulating a fresh unlock) and recover.
    const kek2 = await deriveKek('correct horse battery staple', salt, ITERS);
    const dek2 = await unwrapDek(kek2, wrapped);
    expect(await decryptString(dek2, ct)).toBe('enterprise data');
  });

  it('fails to unwrap with the wrong passphrase (detectable)', async () => {
    const salt = newSalt();
    const wrapped = await wrapDek(await deriveKek('right', salt, ITERS), await generateDek());
    const wrongKek = await deriveKek('wrong', salt, ITERS);
    await expect(unwrapDek(wrongKek, wrapped)).rejects.toBeTruthy();
  });
});
