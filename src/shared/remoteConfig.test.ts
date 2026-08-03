import { describe, expect, it, vi } from 'vitest';
import {
  diffRemoteConfig,
  droppedRemoteConfigKeys,
  fetchRemoteConfigJson,
  isSafeConfigUrl,
  pickAllowedRemoteConfigFields,
} from './remoteConfig';
import type { Settings } from './types';

describe('pickAllowedRemoteConfigFields', () => {
  it('drops secret/endpoint fields even when present alongside allowed ones', () => {
    const out = pickAllowedRemoteConfigFields({
      temperature: 0.5,
      apiKey: 'sk-evil',
      baseUrl: 'https://evil.example.com',
      modelProfiles: [{ id: 'x' }],
    });
    expect(out).toEqual({ temperature: 0.5 });
  });

  it('passes through every allowlisted field', () => {
    const payload = {
      temperature: 0.2,
      maxTokens: 4096,
      repoSearchK: 8,
      hybridSearch: true,
      graphAssistedSearch: false,
      maxSteps: 20,
      model: 'gpt-x',
      systemPrompt: 'be terse',
      promptOverrides: { notebookOverview: 'x' },
      retryOnRateLimit: false,
      summarizeObservations: true,
      verifyAnswers: false,
      restrictBackgroundToLocal: true,
      localEmbedModel: 'Xenova/foo',
    };
    expect(pickAllowedRemoteConfigFields(payload)).toEqual(payload);
  });

  it('tolerates malformed/non-object JSON without throwing', () => {
    expect(pickAllowedRemoteConfigFields(null)).toEqual({});
    expect(pickAllowedRemoteConfigFields(undefined)).toEqual({});
    expect(pickAllowedRemoteConfigFields(42)).toEqual({});
    expect(pickAllowedRemoteConfigFields('a string')).toEqual({});
    expect(pickAllowedRemoteConfigFields([1, 2, 3])).toEqual({});
  });
});

describe('droppedRemoteConfigKeys', () => {
  it('lists keys present in the payload but not applied', () => {
    expect(droppedRemoteConfigKeys({ temperature: 0.5, apiKey: 'x', foo: 1 })).toEqual(['apiKey', 'foo']);
  });
  it('empty for a fully-allowed payload', () => {
    expect(droppedRemoteConfigKeys({ temperature: 0.5 })).toEqual([]);
  });
});

describe('diffRemoteConfig', () => {
  const current = { baseUrl: '', apiKey: '', model: 'm', temperature: 0.2, maxSteps: 20 } as Settings;

  it('reports only fields that actually change', () => {
    const diffs = diffRemoteConfig(current, { temperature: 0.7, maxSteps: 20 });
    expect(diffs).toEqual([{ key: 'temperature', before: 0.2, after: 0.7 }]);
  });

  it('is empty when the incoming value matches the current value', () => {
    expect(diffRemoteConfig(current, { temperature: 0.2 })).toEqual([]);
  });
});

describe('isSafeConfigUrl', () => {
  it('accepts https URLs', () => expect(isSafeConfigUrl('https://example.com/config.json')).toBe(true));
  it('rejects http', () => expect(isSafeConfigUrl('http://example.com/x')).toBe(false));
  it('rejects javascript: and data: schemes', () => {
    expect(isSafeConfigUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeConfigUrl('data:text/html,x')).toBe(false);
  });
  it('rejects unparseable strings', () => expect(isSafeConfigUrl('not a url')).toBe(false));
});

describe('fetchRemoteConfigJson', () => {
  it('rejects a non-https URL without calling fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchRemoteConfigJson('http://example.com', fetchImpl)).rejects.toThrow(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves the parsed JSON on a successful fetch', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ temperature: 0.9 }),
    })) as unknown as typeof fetch;
    await expect(fetchRemoteConfigJson('https://example.com/c.json', fetchImpl)).resolves.toEqual({ temperature: 0.9 });
  });

  it('rejects with the status on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    await expect(fetchRemoteConfigJson('https://example.com/c.json', fetchImpl)).rejects.toThrow(/404/);
  });
});
