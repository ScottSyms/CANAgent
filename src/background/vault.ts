// =============================================================================
// Encryption vault — lifecycle around the crypto primitives (shared/crypto.ts),
// implementing specification.md §8.8 with a *user-derived* key:
//
//   passphrase --PBKDF2--> KEK --wraps--> DEK --AES-GCM--> sensitive values
//
// The wrapped DEK + salt live in chrome.storage.local (`ba_vault`); the unlocked
// raw DEK is cached in chrome.storage.session (`ba_vault_dek`) — memory-only,
// gone when the browser closes, but surviving service-worker eviction so the
// user only unlocks once per browser session. The passphrase is never stored.
//
// The vault is OPT-IN: with no `ba_vault`, vaultEncrypt/vaultDecrypt pass values
// through unchanged, so existing installs are unaffected. Cryptographic erasure
// (§8.8) = destroying the wrapped DEK, which is what eraseVault does.
// =============================================================================

import {
  base64ToBytes,
  bytesToBase64,
  decryptString,
  DEFAULT_PBKDF2_ITERATIONS,
  deriveKek,
  encryptString,
  exportDekRaw,
  generateDek,
  importDek,
  isEncrypted,
  newSalt,
  unwrapDek,
  wrapDek,
  type WrappedDek,
} from '../shared/crypto';

const VAULT_KEY = 'ba_vault';
const DEK_SESSION_KEY = 'ba_vault_dek';

interface VaultRecord {
  version: 1;
  saltB64: string;
  iterations: number;
  wrapped: WrappedDek;
}

export type VaultState = 'none' | 'locked' | 'unlocked';

async function readVault(): Promise<VaultRecord | null> {
  const r = await chrome.storage.local.get(VAULT_KEY);
  return (r[VAULT_KEY] as VaultRecord | undefined) ?? null;
}

async function readSessionDekRaw(): Promise<Uint8Array | null> {
  try {
    const r = await chrome.storage.session.get(DEK_SESSION_KEY);
    const b64 = r[DEK_SESSION_KEY] as string | undefined;
    return b64 ? base64ToBytes(b64) : null;
  } catch {
    return null;
  }
}

/** Whether a vault exists and, if so, whether it is currently unlocked. */
export async function getVaultState(): Promise<VaultState> {
  const vault = await readVault();
  if (!vault) return 'none';
  return (await readSessionDekRaw()) ? 'unlocked' : 'locked';
}

export async function isVaultUnlocked(): Promise<boolean> {
  return (await getVaultState()) === 'unlocked';
}

/** Create a new vault from a passphrase. Fails if one already exists. */
export async function setupVault(passphrase: string): Promise<void> {
  if (!passphrase) throw new Error('A passphrase is required.');
  if (await readVault()) throw new Error('A vault already exists. Change or erase it instead.');
  const salt = newSalt();
  const iterations = DEFAULT_PBKDF2_ITERATIONS;
  const dek = await generateDek();
  const kek = await deriveKek(passphrase, salt, iterations);
  const wrapped = await wrapDek(kek, dek);
  const record: VaultRecord = { version: 1, saltB64: bytesToBase64(salt), iterations, wrapped };
  await chrome.storage.local.set({ [VAULT_KEY]: record });
  await cacheDek(dek);
}

/** Unlock an existing vault. Returns false on a wrong passphrase (never throws for that). */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const vault = await readVault();
  if (!vault) throw new Error('No vault to unlock.');
  const kek = await deriveKek(passphrase, base64ToBytes(vault.saltB64), vault.iterations);
  try {
    const dek = await unwrapDek(kek, vault.wrapped); // GCM auth throws on wrong passphrase
    await cacheDek(dek);
    return true;
  } catch {
    return false;
  }
}

/** Forget the unlocked DEK (re-lock). The vault record stays; unlock again to use it. */
export async function lockVault(): Promise<void> {
  try {
    await chrome.storage.session.remove(DEK_SESSION_KEY);
  } catch {
    // session storage unavailable — nothing cached anyway
  }
}

/** Re-wrap the DEK under a new passphrase (fresh salt). Requires the current one. */
export async function changePassphrase(current: string, next: string): Promise<boolean> {
  const vault = await readVault();
  if (!vault) throw new Error('No vault to change.');
  if (!next) throw new Error('A new passphrase is required.');
  const curKek = await deriveKek(current, base64ToBytes(vault.saltB64), vault.iterations);
  let dek: CryptoKey;
  try {
    dek = await unwrapDek(curKek, vault.wrapped);
  } catch {
    return false; // wrong current passphrase
  }
  const salt = newSalt();
  const iterations = DEFAULT_PBKDF2_ITERATIONS;
  const kek = await deriveKek(next, salt, iterations);
  const wrapped = await wrapDek(kek, dek);
  await chrome.storage.local.set({ [VAULT_KEY]: { version: 1, saltB64: bytesToBase64(salt), iterations, wrapped } satisfies VaultRecord });
  await cacheDek(dek);
  return true;
}

/**
 * Cryptographic erasure (§8.8): destroy the wrapped DEK and the session copy.
 * Any values encrypted under it become permanently unrecoverable — callers that
 * want the plaintext back must re-enter it afterwards.
 */
export async function eraseVault(): Promise<void> {
  await chrome.storage.local.remove(VAULT_KEY);
  await lockVault();
}

async function cacheDek(dek: CryptoKey): Promise<void> {
  const raw = await exportDekRaw(dek);
  await chrome.storage.session.set({ [DEK_SESSION_KEY]: bytesToBase64(raw) });
}

async function unlockedDek(): Promise<CryptoKey | null> {
  const raw = await readSessionDekRaw();
  return raw ? importDek(raw) : null;
}

/**
 * Encrypt a value if the vault is unlocked; otherwise return it unchanged.
 * "Unchanged" covers both the no-vault case (opt-in: stay plaintext) and the
 * locked case (callers should not be writing secrets while locked; the UI gates
 * that). Never double-encrypts an already-enveloped value.
 */
export async function vaultEncrypt(value: string): Promise<string> {
  if (!value || isEncrypted(value)) return value;
  const dek = await unlockedDek();
  return dek ? encryptString(dek, value) : value;
}

/**
 * Decrypt a value if it is an envelope and the vault is unlocked. Returns the
 * value unchanged when it is plaintext (no vault / legacy). Returns `null` when
 * the value IS encrypted but the vault is locked or erased — the signal for
 * "need unlock" (e.g. getSettings then treats the config as unavailable, which
 * correctly renders the agent inert until the user unlocks).
 */
export async function vaultDecrypt(value: string): Promise<string | null> {
  if (!isEncrypted(value)) return value;
  const dek = await unlockedDek();
  if (!dek) return null;
  try {
    return await decryptString(dek, value);
  } catch {
    return null; // tampered or DEK mismatch
  }
}
