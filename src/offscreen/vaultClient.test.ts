import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVaultState, isVaultUnlocked, vaultDecrypt, vaultEncrypt } from './vaultClient';

function stubSendMessage(impl: (msg: { type: string; op: string; value?: string }) => unknown) {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (msg: never) => impl(msg)) } });
}

afterEach(() => vi.unstubAllGlobals());

describe('vaultClient delegation to the service worker', () => {
  it('forwards each op with the right message shape', async () => {
    const seen: Array<{ op: string; value?: string }> = [];
    stubSendMessage((msg) => {
      seen.push({ op: msg.op, value: msg.value });
      if (msg.op === 'state') return { state: 'unlocked' };
      if (msg.op === 'encrypt') return { value: `enc(${msg.value})` };
      return { value: `dec(${msg.value})` };
    });

    expect(await getVaultState()).toBe('unlocked');
    expect(await isVaultUnlocked()).toBe(true);
    expect(await vaultEncrypt('secret')).toBe('enc(secret)');
    expect(await vaultDecrypt('blob')).toBe('dec(blob)');
    expect(seen).toContainEqual({ op: 'encrypt', value: 'secret' });
    expect(seen).toContainEqual({ op: 'decrypt', value: 'blob' });
  });

  it('degrades to "none"/null when the service worker is unreachable (no re-crash)', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => {
          throw new Error('Receiving end does not exist');
        }),
      },
    });
    expect(await getVaultState()).toBe('none');
    expect(await isVaultUnlocked()).toBe(false);
    expect(await vaultDecrypt('blob')).toBeNull();
  });

  it('propagates encrypt errors rather than silently writing plaintext', async () => {
    stubSendMessage((msg) => (msg.op === 'encrypt' ? { error: 'boom' } : { state: 'unlocked' }));
    await expect(vaultEncrypt('secret')).rejects.toThrow('boom');
  });
});
