import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isEncrypted } from '../shared/crypto';
import {
  changePassphrase,
  eraseVault,
  getVaultState,
  lockVault,
  setupVault,
  unlockVault,
  vaultDecrypt,
  vaultEncrypt,
} from './vault';

function makeArea() {
  const store: Record<string, unknown> = {};
  return {
    store,
    api: {
      async get(key: string) {
        return key in store ? { [key]: store[key] } : {};
      },
      async set(obj: Record<string, unknown>) {
        Object.assign(store, obj);
      },
      async remove(key: string) {
        delete store[key];
      },
    },
  };
}

beforeEach(() => {
  const local = makeArea();
  const session = makeArea();
  vi.stubGlobal('chrome', { storage: { local: local.api, session: session.api } });
});

describe('vault lifecycle', () => {
  it('starts at "none" and passes values through unencrypted', async () => {
    expect(await getVaultState()).toBe('none');
    expect(await vaultEncrypt('sk-123')).toBe('sk-123'); // opt-in: no vault => plaintext
    expect(await vaultDecrypt('sk-123')).toBe('sk-123');
  });

  it('setup unlocks and enables encryption; values round-trip', async () => {
    await setupVault('correct horse battery staple');
    expect(await getVaultState()).toBe('unlocked');
    const ct = await vaultEncrypt('sk-secret');
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain('sk-secret');
    expect(await vaultDecrypt(ct)).toBe('sk-secret');
  });

  it('locking hides the DEK: encrypted values become undecryptable (null) until unlock', async () => {
    await setupVault('pw');
    const ct = await vaultEncrypt('enterprise data');
    await lockVault();
    expect(await getVaultState()).toBe('locked');
    expect(await vaultDecrypt(ct)).toBeNull();
    // while locked, vaultEncrypt cannot encrypt — passes through unchanged
    expect(await vaultEncrypt('new')).toBe('new');

    expect(await unlockVault('pw')).toBe(true);
    expect(await getVaultState()).toBe('unlocked');
    expect(await vaultDecrypt(ct)).toBe('enterprise data');
  });

  it('rejects a wrong passphrase without throwing', async () => {
    await setupVault('right');
    await lockVault();
    expect(await unlockVault('wrong')).toBe(false);
    expect(await getVaultState()).toBe('locked');
  });

  it('changePassphrase re-wraps the same DEK; old data still decrypts, old passphrase fails', async () => {
    await setupVault('old-pw');
    const ct = await vaultEncrypt('data');
    expect(await changePassphrase('old-pw', 'new-pw')).toBe(true);
    await lockVault();
    expect(await unlockVault('old-pw')).toBe(false);
    expect(await unlockVault('new-pw')).toBe(true);
    expect(await vaultDecrypt(ct)).toBe('data');
  });

  it('erase destroys the wrapped DEK — data is cryptographically unrecoverable', async () => {
    await setupVault('pw');
    const ct = await vaultEncrypt('secret');
    await eraseVault();
    expect(await getVaultState()).toBe('none');
    // Even the correct passphrase can no longer help — the wrapped DEK is gone.
    expect(await vaultDecrypt(ct)).toBeNull();
  });

  it('does not double-encrypt an already-enveloped value', async () => {
    await setupVault('pw');
    const once = await vaultEncrypt('x');
    const twice = await vaultEncrypt(once);
    expect(twice).toBe(once);
  });
});
