import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeArea() {
  const store: Record<string, unknown> = {};
  return {
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(obj: Record<string, unknown>) {
      Object.assign(store, obj);
    },
    async remove(key: string) {
      delete store[key];
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('chrome', { storage: { local: makeArea(), session: makeArea() } });
});

describe('provider registry', () => {
  it('lists exactly the four required providers', async () => {
    const { listProviderDescriptors } = await import('./registry');
    const ids = listProviderDescriptors()
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(['github-copilot', 'gitlab-duo', 'openai-chatgpt', 'xai-grok']);
  });

  it('reports only documented provider decisions', async () => {
    const { PROVIDER_DESCRIPTORS } = await import('./registry');
    expect(PROVIDER_DESCRIPTORS['openai-chatgpt'].decision).toBe('local_companion');
    expect(PROVIDER_DESCRIPTORS['xai-grok'].decision).toBe('api_key_only');
    expect(PROVIDER_DESCRIPTORS['gitlab-duo'].decision).toBe('blocked');
    expect(PROVIDER_DESCRIPTORS['openai-chatgpt'].summary).toMatch(/Codex/i);
    expect(PROVIDER_DESCRIPTORS['xai-grok'].summary).toMatch(/API key/i);
  });

  it('marks GitHub and Codex as local companions', async () => {
    const { PROVIDER_DESCRIPTORS } = await import('./registry');
    expect(PROVIDER_DESCRIPTORS['github-copilot'].decision).toBe('local_companion');
    expect(PROVIDER_DESCRIPTORS['openai-chatgpt'].decision).toBe('local_companion');
  });

  it('every descriptor capability set only advertises auth modes it actually implements', async () => {
    const { PROVIDER_DESCRIPTORS } = await import('./registry');
    expect(PROVIDER_DESCRIPTORS['github-copilot'].capabilities.authModes).toContain('oauth-device');
    expect(PROVIDER_DESCRIPTORS['gitlab-duo'].capabilities.authModes).toContain('unsupported');
    expect(PROVIDER_DESCRIPTORS['openai-chatgpt'].capabilities.authModes).toContain('local-companion');
    expect(PROVIDER_DESCRIPTORS['xai-grok'].capabilities.authModes).toEqual(['api-key']);
  });

  it('getProvider returns a stable singleton per id and matches its own id', async () => {
    const { getProvider } = await import('./registry');
    const a = getProvider('gitlab-duo');
    const b = getProvider('gitlab-duo');
    expect(a).toBe(b);
    expect(a.id).toBe('gitlab-duo');
  });
});
