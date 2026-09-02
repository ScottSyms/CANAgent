import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XaiGrokProvider } from './xaiGrok';

function stubSettings(settings: Record<string, unknown>) {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get() {
          return { ba_settings: settings };
        },
      },
    },
  });
}

beforeEach(() => {
  stubSettings({ baseUrl: '', apiKey: '', model: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('XaiGrokProvider', () => {
  it('connect() always refuses — no sanctioned third-party subscription OAuth path', async () => {
    const provider = new XaiGrokProvider();
    await expect(provider.connect()).rejects.toThrow(/does not document a third-party OAuth/i);
  });

  it('reports connected once an api.x.ai API key exists in Settings', async () => {
    stubSettings({ baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-abc', model: 'grok-4' });
    const provider = new XaiGrokProvider();
    expect((await provider.getConnectionStatus()).status).toBe('connected');
  });

  it('listModels calls /models with the configured key', async () => {
    stubSettings({ baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-abc', model: 'grok-4' });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'grok-4' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new XaiGrokProvider();
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['grok-4']);
  });

  it('getAccountInfo notes this is API-key billing, not a SuperGrok subscription', async () => {
    stubSettings({ baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-abc', model: 'grok-4' });
    const provider = new XaiGrokProvider();
    const info = await provider.getAccountInfo();
    expect(info?.note).toMatch(/not tied to a SuperGrok/i);
  });
});
