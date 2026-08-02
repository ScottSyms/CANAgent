// Offscreen-side vault access. The encryption vault's wrapped DEK lives in
// chrome.storage, which is not reliably available inside the offscreen document
// on every Chrome build — reaching for it there throws `reading 'local'` and
// aborts ingestion. So the offscreen never touches storage or key material
// directly: it delegates the four operations the repo store needs to the service
// worker (which always has storage and holds the unlocked DEK) over a `vault_op`
// message. This drop-in replaces the direct `../background/vault` import in
// repoStore.ts, so call sites are unchanged.

import type { VaultState } from '../background/vault';

interface VaultOpResult {
  state?: VaultState;
  value?: string | null;
  error?: string;
}

async function vaultOp(op: 'state' | 'encrypt' | 'decrypt', value?: string): Promise<VaultOpResult> {
  const res = (await chrome.runtime.sendMessage({ type: 'vault_op', op, value })) as VaultOpResult | undefined;
  if (!res) throw new Error('No response from the vault service.');
  if (res.error) throw new Error(res.error);
  return res;
}

/**
 * Current vault state via the service worker. Degrades to `'none'` if the SW is
 * unreachable — never re-introduces the crash that blocked ingestion. `'none'`
 * means content is treated as plaintext, which is the only workable outcome when
 * the vault genuinely can't be reached.
 */
export async function getVaultState(): Promise<VaultState> {
  try {
    return (await vaultOp('state')).state ?? 'none';
  } catch {
    return 'none';
  }
}

export async function isVaultUnlocked(): Promise<boolean> {
  return (await getVaultState()) === 'unlocked';
}

/**
 * Encrypt via the SW. Errors propagate (rather than silently returning plaintext)
 * so a failed write surfaces instead of writing cleartext into an encrypted repo.
 * Only reached when the vault is unlocked, i.e. the SW is known reachable.
 */
export async function vaultEncrypt(value: string): Promise<string> {
  const res = await vaultOp('encrypt', value);
  return res.value ?? value;
}

/**
 * Decrypt via the SW. Returns null when the vault is locked/unavailable (mirrors
 * the real vault), so an encrypted file resolves to its empty fallback rather
 * than surfacing ciphertext.
 */
export async function vaultDecrypt(value: string): Promise<string | null> {
  try {
    return (await vaultOp('decrypt', value)).value ?? null;
  } catch {
    return null;
  }
}
