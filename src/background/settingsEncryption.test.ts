import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENC_PREFIX } from '../shared/crypto';
import type { Settings } from '../shared/types';
import { getSettings, getSettingsForEdit, saveSettings } from './storage';
import { lockVault, setupVault, unlockVault } from './vault';

let local: Record<string, unknown>;
let session: Record<string, unknown>;
function area(store: Record<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj: Record<string, unknown>) { Object.assign(store, obj); },
    async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]; },
  };
}
beforeEach(() => {
  local = {};
  session = {};
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) } });
});

const full: Settings = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-main',
  model: 'gpt-x',
  ideogramApiKey: 'ik-img',
  embeddingApiKey: 'sk-embed',
  transcriptionApiKey: 'sk-trans',
};

const SECRETS = ['apiKey', 'ideogramApiKey', 'embeddingApiKey', 'transcriptionApiKey'] as const;

describe('settings secret encryption at rest', () => {
  it('no vault: secrets stored and returned in plaintext', async () => {
    await saveSettings(full);
    const raw = JSON.stringify(local['ba_settings']);
    for (const s of SECRETS) expect(raw).toContain(full[s]!);
    expect((await getSettings())?.transcriptionApiKey).toBe('sk-trans');
  });

  it('accepts a subscription provider without endpoint credentials', async () => {
    await saveSettings({
      baseUrl: '',
      apiKey: '',
      model: 'copilot-model',
      subscriptionProvider: 'github-copilot',
    });
    await expect(getSettings()).resolves.toMatchObject({
      model: 'copilot-model',
      subscriptionProvider: 'github-copilot',
      apiKey: '',
    });
  });

  it('unlocked vault: every secret field is ciphertext at rest, decrypted on read', async () => {
    await setupVault('correct horse battery staple');
    await saveSettings(full);

    const stored = local['ba_settings'] as Settings;
    for (const s of SECRETS) {
      expect(stored[s]!.startsWith(ENC_PREFIX)).toBe(true);
      expect(stored[s]).not.toBe(full[s]);
    }
    // non-secret fields stay plaintext
    expect(stored.baseUrl).toBe(full.baseUrl);
    expect(stored.model).toBe(full.model);

    const got = await getSettings();
    for (const s of SECRETS) expect(got?.[s]).toBe(full[s]);
    const edit = await getSettingsForEdit();
    expect(edit.locked).toBe(false);
    for (const s of SECRETS) expect(edit.settings[s]).toBe(full[s]);
  });

  it('locked vault: getSettings is null and getSettingsForEdit reports locked', async () => {
    await setupVault('pw');
    await saveSettings(full);
    await lockVault();

    expect(await getSettings()).toBeNull();
    const edit = await getSettingsForEdit();
    expect(edit.locked).toBe(true);
    expect(edit.settings.apiKey).toBe('');

    await unlockVault('pw');
    expect((await getSettings())?.embeddingApiKey).toBe('sk-embed');
  });

  it('saving is refused while the vault is locked (would clobber ciphertext)', async () => {
    await setupVault('pw');
    await saveSettings(full);
    await lockVault();
    await expect(saveSettings(full)).rejects.toThrow(/vault is locked/i);
  });
});
