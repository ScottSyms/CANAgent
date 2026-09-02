import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, isExpired, loadToken, saveToken } from './tokenStore';

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

let local: ReturnType<typeof makeArea>;

beforeEach(() => {
  local = makeArea();
  vi.stubGlobal('chrome', { storage: { local: local.api } });
});

describe('tokenStore', () => {
  it('round-trips a token, keyed per provider (no cross-provider leakage)', async () => {
    await saveToken('github-copilot', { accessToken: 'gh-token' });
    await saveToken('gitlab-duo', { accessToken: 'gl-token' });
    expect((await loadToken('github-copilot'))?.accessToken).toBe('gh-token');
    expect((await loadToken('gitlab-duo'))?.accessToken).toBe('gl-token');
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadToken('xai-grok')).toBeNull();
  });

  it('clearToken removes only that provider', async () => {
    await saveToken('github-copilot', { accessToken: 'gh-token' });
    await saveToken('gitlab-duo', { accessToken: 'gl-token' });
    await clearToken('github-copilot');
    expect(await loadToken('github-copilot')).toBeNull();
    expect((await loadToken('gitlab-duo'))?.accessToken).toBe('gl-token');
  });

  it('never writes to chrome.storage.sync', async () => {
    const syncSet = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: local.api, sync: { set: syncSet } } });
    await saveToken('github-copilot', { accessToken: 'gh-token' });
    expect(syncSet).not.toHaveBeenCalled();
  });

  it('lazily migrates an unversioned token record', async () => {
    local.store['ba_provider_tokens_github-copilot'] = { accessToken: 'old-token' };
    expect((await loadToken('github-copilot'))?.schemaVersion).toBe(1);
    expect((local.store['ba_provider_tokens_github-copilot'] as { schemaVersion?: number }).schemaVersion).toBe(1);
  });

  it('removes malformed records instead of exposing them to providers', async () => {
    local.store['ba_provider_tokens_github-copilot'] = { accessToken: 42 };
    expect(await loadToken('github-copilot')).toBeNull();
    expect(local.store['ba_provider_tokens_github-copilot']).toBeUndefined();
  });
});

describe('isExpired', () => {
  it('is false for a non-expiring (no expiresAt) token', () => {
    expect(isExpired({ accessToken: 'x' })).toBe(false);
  });

  it('is true once past expiresAt', () => {
    expect(isExpired({ accessToken: 'x', expiresAt: Date.now() - 1000 })).toBe(true);
  });

  it('is false before expiresAt', () => {
    expect(isExpired({ accessToken: 'x', expiresAt: Date.now() + 100_000 })).toBe(false);
  });
});
