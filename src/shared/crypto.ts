// =============================================================================
// Application-layer encryption primitives (specification.md §8.8). A
// per-installation data-encryption key (DEK) encrypts sensitive values with
// authenticated encryption (AES-256-GCM); the DEK is itself wrapped by a
// key-encryption key (KEK) derived from the user's passphrase (PBKDF2-SHA-256).
// Destroying the wrapped DEK cryptographically erases everything (§8.8).
//
// Pure WebCrypto — no chrome.*, no DOM — so it unit-tests in Node. The vault
// lifecycle (storage, session caching, lock state) lives in background/vault.ts.
// =============================================================================

// OWASP-recommended floor for PBKDF2-HMAC-SHA256 (2023). Stored per-vault so it
// can be raised later without breaking existing vaults. Tests pass a small value.
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/** Envelope prefix marking a value as encrypted, so the storage layer can tell
 *  ciphertext from a legacy plaintext value and decrypt only when needed. */
export const ENC_PREFIX = 'enc:v1:';

const IV_BYTES = 12; // AES-GCM standard nonce length
const SALT_BYTES = 16;
const DEK_BYTES = 32; // AES-256

// ---- base64 <-> bytes (no Buffer; works in SW/worker/window) ----------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function newSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

// ---- key derivation & DEK lifecycle -----------------------------------------

/** Derive the passphrase-based KEK (an AES-GCM key used only to wrap the DEK). */
export async function deriveKek(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Generate a fresh random DEK (extractable so it can be wrapped and session-cached). */
export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Import a raw 32-byte DEK (e.g. from the session cache). */
export async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', dek));
}

export interface WrappedDek {
  wrappedB64: string; // AES-GCM ciphertext of the raw DEK
  ivB64: string;
}

/** Wrap (encrypt) the DEK under the KEK. */
export async function wrapDek(kek: CryptoKey, dek: CryptoKey): Promise<WrappedDek> {
  const raw = await exportDekRaw(dek);
  if (raw.length !== DEK_BYTES) throw new Error('unexpected DEK length');
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, kek, raw as unknown as BufferSource));
  return { wrappedB64: bytesToBase64(ct), ivB64: bytesToBase64(iv) };
}

/**
 * Unwrap (decrypt) the DEK under the KEK. Throws if the passphrase is wrong —
 * GCM authentication fails on a bad KEK, which is how callers detect a wrong
 * passphrase versus a corrupt vault.
 */
export async function unwrapDek(kek: CryptoKey, wrapped: WrappedDek): Promise<CryptoKey> {
  const ct = base64ToBytes(wrapped.wrappedB64);
  const iv = base64ToBytes(wrapped.ivB64);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, kek, ct as unknown as BufferSource));
  return importDek(raw);
}

// ---- value encryption --------------------------------------------------------

/** True when a stored value is an encryption envelope this module produced. */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** Encrypt a string to a self-describing envelope: `enc:v1:<base64(iv || ciphertext)>`. */
export async function encryptString(dek: CryptoKey, plaintext: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, dek, new TextEncoder().encode(plaintext) as unknown as BufferSource));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv, 0);
  joined.set(ct, iv.length);
  return ENC_PREFIX + bytesToBase64(joined);
}

/** Decrypt an envelope produced by encryptString. Throws on tamper/wrong key. */
export async function decryptString(dek: CryptoKey, payload: string): Promise<string> {
  if (!isEncrypted(payload)) throw new Error('not an encryption envelope');
  const joined = base64ToBytes(payload.slice(ENC_PREFIX.length));
  const iv = joined.subarray(0, IV_BYTES);
  const ct = joined.subarray(IV_BYTES);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, dek, ct as unknown as BufferSource));
  return new TextDecoder().decode(pt);
}
