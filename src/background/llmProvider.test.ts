import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile, Settings } from '../shared/types';
import {
  apiVersion,
  authHeaders,
  buildUrl,
  complete,
  messagesContainImage,
  resolveModelForRole,
  testConnection,
  type LlmMessage,
} from './llmProvider';

const base: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt' };

const localProfile: ModelProfile = {
  id: 'p1',
  name: 'Local utility',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'llama3',
  privacyTier: 'local',
};

const cloudProfile: ModelProfile = {
  id: 'p2',
  name: 'Cheap cloud',
  baseUrl: 'https://cheap.example.com/v1',
  apiKey: 'sk-cheap',
  model: 'mini',
  privacyTier: 'cloud',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiVersion (Azure mode detection)', () => {
  it('is undefined for a standard OpenAI endpoint', () => {
    expect(apiVersion(base)).toBeUndefined();
  });

  it('returns the trimmed version string when set', () => {
    expect(apiVersion({ ...base, apiVersion: '  2024-02-01 ' })).toBe('2024-02-01');
  });

  it('treats a blank string as not-Azure', () => {
    expect(apiVersion({ ...base, apiVersion: '   ' })).toBeUndefined();
  });
});

describe('buildUrl', () => {
  it('appends only the route path for standard OpenAI', () => {
    expect(buildUrl('https://api.example.com/v1', '/chat/completions', undefined)).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('appends the api-version query param in Azure mode', () => {
    expect(
      buildUrl(
        'https://name.openai.azure.com/openai/deployments/gpt4o',
        '/chat/completions',
        '2024-02-01',
      ),
    ).toBe(
      'https://name.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-02-01',
    );
  });
});

describe('authHeaders', () => {
  it('uses Bearer auth for standard OpenAI', () => {
    expect(authHeaders('sk-test', undefined)).toEqual({ Authorization: 'Bearer sk-test' });
  });

  it('uses the api-key header in Azure mode', () => {
    expect(authHeaders('sk-test', '2024-02-01')).toEqual({ 'api-key': 'sk-test' });
  });
});

describe('testConnection', () => {
  it('constrains the probe so local servers do not run to their default token cap', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const result = await testConnection({ ...base, maxTokens: 2048, temperature: 1 });

    expect(result.ok).toBe(true);
    expect(requestBody).toMatchObject({ max_tokens: 8, temperature: 0 });
  });
});

describe('complete (protocol dispatch)', () => {
  it('defaults to the chat-completions adapter when protocol is unset', async () => {
    let requestUrl: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
      }),
    );
    const message = await complete(base, [{ role: 'user', content: 'hi' }]);
    expect(requestUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(requestBody).toMatchObject({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });
    expect(message).toEqual({ role: 'assistant', content: 'ok' });
  });

  it('dispatches to the anthropic-messages adapter, translating headers, url, and response shape', async () => {
    let requestUrl: string | undefined;
    let headers: HeadersInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = String(input);
        headers = init?.headers;
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi from claude' }] }), { status: 200 });
      }),
    );
    const anthropicSettings: Settings = { ...base, protocol: 'anthropic-messages' };
    const message = await complete(anthropicSettings, [{ role: 'user', content: 'hi' }]);
    expect(requestUrl).toBe('https://api.example.com/v1/v1/messages');
    expect((headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect(message).toEqual({ role: 'assistant', content: 'hi from claude' });
  });

  it('dispatches to the gemini-native adapter, translating url and response shape', async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl = String(input);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }] }), { status: 200 });
      }),
    );
    const geminiSettings: Settings = { ...base, protocol: 'gemini-native', model: 'gemini-3-flash' };
    const message = await complete(geminiSettings, [{ role: 'user', content: 'hi' }]);
    expect(requestUrl).toBe('https://api.example.com/v1/v1beta/models/gemini-3-flash:generateContent');
    expect(message).toEqual({ role: 'assistant', content: 'hi from gemini' });
  });

  it('dispatches to the responses adapter, translating url and response shape', async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl = String(input);
        return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi from gpt-5' }] }] }), {
          status: 200,
        });
      }),
    );
    const responsesSettings: Settings = { ...base, protocol: 'responses' };
    const message = await complete(responsesSettings, [{ role: 'user', content: 'hi' }]);
    expect(requestUrl).toBe('https://api.example.com/v1/responses');
    expect(message).toEqual({ role: 'assistant', content: 'hi from gpt-5' });
  });
});

describe('resolveModelForRole', () => {
  it('never routes the main role — always the settings as-is', () => {
    const settings: Settings = { ...base, modelProfiles: [localProfile], roleProfiles: { utility: 'p1' } };
    expect(resolveModelForRole(settings, 'main')).toBe(settings);
  });

  it('falls back to settings unchanged when no role mapping exists', () => {
    expect(resolveModelForRole(base, 'utility')).toBe(base);
  });

  it('falls back to settings unchanged when the mapped profile id has no match', () => {
    const settings: Settings = { ...base, roleProfiles: { utility: 'missing' } };
    expect(resolveModelForRole(settings, 'utility')).toBe(settings);
  });

  it('swaps in the mapped profile\'s connection fields', () => {
    const settings: Settings = { ...base, modelProfiles: [localProfile], roleProfiles: { utility: 'p1' } };
    const resolved = resolveModelForRole(settings, 'utility');
    expect(resolved.baseUrl).toBe(localProfile.baseUrl);
    expect(resolved.apiKey).toBe(localProfile.apiKey);
    expect(resolved.model).toBe(localProfile.model);
  });

  it('a profile field left unset falls back to the main settings value', () => {
    const settings: Settings = {
      ...base,
      temperature: 0.7,
      maxTokens: 500,
      modelProfiles: [localProfile], // no temperature/maxTokens of its own
      roleProfiles: { utility: 'p1' },
    };
    const resolved = resolveModelForRole(settings, 'utility');
    expect(resolved.temperature).toBe(0.7);
    expect(resolved.maxTokens).toBe(500);
  });

  it('restrictBackgroundToLocal skips a cloud-tagged profile, falling back to main', () => {
    const settings: Settings = {
      ...base,
      restrictBackgroundToLocal: true,
      modelProfiles: [cloudProfile],
      roleProfiles: { utility: 'p2' },
    };
    expect(resolveModelForRole(settings, 'utility')).toBe(settings);
  });

  it('restrictBackgroundToLocal still allows a local-tagged profile through', () => {
    const settings: Settings = {
      ...base,
      restrictBackgroundToLocal: true,
      modelProfiles: [localProfile],
      roleProfiles: { utility: 'p1' },
    };
    expect(resolveModelForRole(settings, 'utility').baseUrl).toBe(localProfile.baseUrl);
  });

  it('restrictBackgroundToLocal skips an untagged profile too (conservative default)', () => {
    const untagged: ModelProfile = { ...localProfile, privacyTier: undefined };
    const settings: Settings = {
      ...base,
      restrictBackgroundToLocal: true,
      modelProfiles: [untagged],
      roleProfiles: { utility: 'p1' },
    };
    expect(resolveModelForRole(settings, 'utility')).toBe(settings);
  });

  it('without restrictBackgroundToLocal, a cloud-tagged profile is used normally', () => {
    const settings: Settings = { ...base, modelProfiles: [cloudProfile], roleProfiles: { reflection: 'p2' } };
    expect(resolveModelForRole(settings, 'reflection').model).toBe(cloudProfile.model);
  });
});

describe('messagesContainImage', () => {
  it('is false for plain string-content messages', () => {
    const msgs: LlmMessage[] = [
      { role: 'system', content: 'you are a helpful agent' },
      { role: 'user', content: 'summarize this page' },
    ];
    expect(messagesContainImage(msgs)).toBe(false);
  });

  it('is false when a content array has only text parts', () => {
    const msgs: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    expect(messagesContainImage(msgs)).toBe(false);
  });

  it('is true when any message carries an image_url part', () => {
    const msgs: LlmMessage[] = [
      { role: 'user', content: 'earlier text turn' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'interpret this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];
    expect(messagesContainImage(msgs)).toBe(true);
  });

  it('tolerates null content (assistant tool-call turns)', () => {
    const msgs: LlmMessage[] = [{ role: 'assistant', content: null }];
    expect(messagesContainImage(msgs)).toBe(false);
  });
});

describe('vision routing (image-bearing calls go to the vision profile)', () => {
  // Mirrors AgentRuntime.modelForCall: route to the vision profile only when the
  // outgoing messages carry an image; otherwise the main model is used as-is.
  const visionProfile: ModelProfile = {
    id: 'pv',
    name: 'Image interpretation',
    baseUrl: 'https://vision.example.com/v1',
    apiKey: 'sk-vision',
    model: 'gemini-3-flash',
    privacyTier: 'cloud',
    capabilities: { vision: true },
  };
  const withVision: Settings = { ...base, modelProfiles: [visionProfile], roleProfiles: { vision: 'pv' } };
  const modelForCall = (settings: Settings, msgs: LlmMessage[]): Settings =>
    messagesContainImage(msgs) ? resolveModelForRole(settings, 'vision') : settings;

  const textMsgs: LlmMessage[] = [{ role: 'user', content: 'plain question' }];
  const imageMsgs: LlmMessage[] = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ];

  it('keeps the main model for a text-only call', () => {
    expect(modelForCall(withVision, textMsgs)).toBe(withVision);
  });

  it('routes an image-bearing call to the vision profile', () => {
    expect(modelForCall(withVision, imageMsgs).model).toBe('gemini-3-flash');
  });

  it('with no vision profile, an image-bearing call stays on the main model (unchanged behavior)', () => {
    expect(modelForCall(base, imageMsgs)).toBe(base);
  });
});
