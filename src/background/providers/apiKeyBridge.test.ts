import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findConnectionByHost } from './apiKeyBridge';

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

describe('findConnectionByHost', () => {
  it('finds the main connection when its baseUrl matches', async () => {
    stubSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abc', model: 'gpt-5' });
    const conn = await findConnectionByHost('api.openai.com');
    expect(conn).toEqual({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abc', model: 'gpt-5', source: 'main' });
  });

  it('falls back to a matching ModelProfile when the main connection is a different host', async () => {
    stubSettings({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'anthropic-key',
      model: 'claude',
      modelProfiles: [
        { id: 'p1', name: 'xai-fast', baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-abc', model: 'grok-4' },
      ],
    });
    const conn = await findConnectionByHost('api.x.ai');
    expect(conn).toEqual({ baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-abc', model: 'grok-4', source: 'xai-fast' });
  });

  it('returns null when nothing matches', async () => {
    stubSettings({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude' });
    expect(await findConnectionByHost('api.x.ai')).toBeNull();
  });

  it('ignores a host match with no API key configured', async () => {
    stubSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-5' });
    expect(await findConnectionByHost('api.openai.com')).toBeNull();
  });

  it('rejects deceptive hostnames and encrypted vault values', async () => {
    stubSettings({ baseUrl: 'https://api.openai.com.evil.example/v1', apiKey: 'sk-abc', model: 'gpt-5' });
    expect(await findConnectionByHost('api.openai.com')).toBeNull();
    stubSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: 'enc:v1:ciphertext', model: 'gpt-5' });
    expect(await findConnectionByHost('api.openai.com')).toBeNull();
  });
});
