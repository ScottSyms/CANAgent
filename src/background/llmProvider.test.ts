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

  it('omits authentication for local endpoints that do not require a key', () => {
    expect(authHeaders('', undefined)).toEqual({});
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

  it('reports the final request URL without dumping an HTML error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html><body>Not found</body></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })),
    );

    const result = await testConnection({
      ...base,
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'gemini-3.6-flash',
      protocol: 'gemini-native',
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('https://opencode.ai/zen/v1/models/gemini-3.6-flash:generateContent');
    expect(result.detail).toContain('returned an HTML page');
    expect(result.detail).not.toContain('<!DOCTYPE');
  });

  it('gives Gemini enough output budget to return text after internal reasoning', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const result = await testConnection({ ...base, protocol: 'gemini-native', model: 'gemini-3.6-flash' });

    expect(result.ok).toBe(true);
    expect(requestBody).toMatchObject({ generationConfig: { maxOutputTokens: 256, temperature: 0 } });
  });

  it('meets the Responses API minimum output budget', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const result = await testConnection({ ...base, protocol: 'responses', model: 'gpt-5.4-mini' });

    expect(result.ok).toBe(true);
    expect(requestBody).toMatchObject({ max_output_tokens: 256 });
    expect(requestBody).not.toHaveProperty('temperature');
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
    expect(requestUrl).toBe('https://api.example.com/v1/messages');
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
    expect(requestUrl).toBe('https://api.example.com/v1/models/gemini-3-flash:generateContent');
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

  it('retries one transient HTTP-200 provider failure before returning content', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: 'error',
          message: { role: 'assistant', content: null },
          error: { code: 502, message: 'Provider unavailable', metadata: { error_type: 'provider_unavailable' } },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'recovered' } }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete(base, [{ role: 'user', content: 'hi' }])).resolves.toMatchObject({ content: 'recovered' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the provider error after one unsuccessful parsed retry', async () => {
    const response = () => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'error',
        message: { role: 'assistant', content: null },
        error: {
          code: 502,
          message: 'Gemini upstream returned no output',
          metadata: { error_type: 'provider_unavailable' },
        },
      }],
    }), { status: 200 });
    const fetchMock = vi.fn().mockImplementation(response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete(base, [{ role: 'user', content: 'hi' }])).rejects.toThrow('Gemini upstream returned no output');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a length-limited empty response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete(base, [{ role: 'user', content: 'hi' }])).rejects.toThrow('Increase Max tokens');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still throws on finish_reason:"length" when the model produced content, but carries that content on the error instead of discarding it', async () => {
    // Real-world case: a small local model cuts off mid-JSON. The main
    // chat/agent loop has no use for a truncated reply and should keep
    // treating this as a hard failure -- but a caller with its own
    // truncation-recovery logic (graphExtract.ts's extractOneDoc) needs the
    // partial content LlmError.content carries, not just the error message.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"entities":[{"label":"X"' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await complete(base, [{ role: 'user', content: 'hi' }]);
      expect.unreachable();
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ name: 'LlmError' });
    expect((caught as { content?: string }).content).toBe('{"entities":[{"label":"X"');
    expect(fetchMock).toHaveBeenCalledTimes(1); // not retried -- this is a hard failure for ordinary callers
  });
});

describe('complete (responseFormat / constrained JSON output)', () => {
  const schema = { name: 'test_schema', schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } };

  it('sets response_format on the chat-completions body when responseFormat is passed', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
      }),
    );
    await complete(base, [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, schema);
    expect(requestBody?.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_schema', strict: true, schema: schema.schema },
    });
  });

  it('omits response_format entirely when no responseFormat is passed', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
      }),
    );
    await complete(base, [{ role: 'user', content: 'hi' }]);
    expect(requestBody?.response_format).toBeUndefined();
  });

  it('sets text.format on the responses-protocol body (different key/shape than chat-completions)', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }), { status: 200 });
      }),
    );
    const responsesSettings: Settings = { ...base, protocol: 'responses' };
    await complete(responsesSettings, [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, schema);
    expect(requestBody?.text).toEqual({
      format: { type: 'json_schema', name: 'test_schema', schema: schema.schema, strict: true },
    });
  });

  it('sets generationConfig.responseSchema/responseMimeType on the gemini-native body', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
      }),
    );
    const geminiSettings: Settings = { ...base, protocol: 'gemini-native' };
    await complete(geminiSettings, [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, schema);
    const generationConfig = requestBody?.generationConfig as Record<string, unknown>;
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect(generationConfig.responseSchema).toEqual(schema.schema);
  });

  it('leaves the anthropic-messages body untouched (no native constrained-decoding field)', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
      }),
    );
    const anthropicSettings: Settings = { ...base, protocol: 'anthropic-messages' };
    await complete(anthropicSettings, [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, schema);
    expect(Object.keys(requestBody ?? {})).not.toContain('response_format');
    expect(Object.keys(requestBody ?? {})).not.toContain('text');
  });

  it('falls back to a request without responseFormat after a 4xx, and succeeds', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) return new Response('{"error":"unknown field response_format"}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'recovered without schema' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const message = await complete(base, [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, schema);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0].response_format).toBeDefined();
    expect(bodies[1].response_format).toBeUndefined();
    expect(message).toEqual({ role: 'assistant', content: 'recovered without schema' });
  });

  it('does not fall back (and just surfaces the error) on a 4xx when no responseFormat was requested', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete(base, [{ role: 'user', content: 'hi' }])).rejects.toThrow('returned 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fall back on a 5xx even with responseFormat set (that failure class is unrelated to schema support)', async () => {
    const fetchMock = vi.fn(async () => new Response('server error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      complete({ ...base, retryOnRateLimit: false }, [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, schema),
    ).rejects.toThrow('returned 500');
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

  it('resolves graphWindowChars the same way as maxTokens/temperature: profile overrides, falls back to main settings, absent stays absent', () => {
    const profileOverride: ModelProfile = { ...localProfile, graphWindowChars: 3000 };
    const withProfileOverride: Settings = {
      ...base,
      modelProfiles: [profileOverride],
      roleProfiles: { knowledgeGraph: 'p1' },
    };
    expect(resolveModelForRole(withProfileOverride, 'knowledgeGraph').graphWindowChars).toBe(3000);

    const withMainFallback: Settings = {
      ...base,
      graphWindowChars: 4000,
      modelProfiles: [localProfile], // no graphWindowChars of its own
      roleProfiles: { knowledgeGraph: 'p1' },
    };
    expect(resolveModelForRole(withMainFallback, 'knowledgeGraph').graphWindowChars).toBe(4000);

    const withNeither: Settings = { ...base, modelProfiles: [localProfile], roleProfiles: { knowledgeGraph: 'p1' } };
    expect(resolveModelForRole(withNeither, 'knowledgeGraph').graphWindowChars).toBeUndefined();
  });

  it('resolves graphGleaningEnabled the same profile-overrides-main-falls-back way', () => {
    const profileOverride: ModelProfile = { ...localProfile, graphGleaningEnabled: false };
    const withProfileOverride: Settings = {
      ...base,
      modelProfiles: [profileOverride],
      roleProfiles: { knowledgeGraph: 'p1' },
    };
    expect(resolveModelForRole(withProfileOverride, 'knowledgeGraph').graphGleaningEnabled).toBe(false);

    const withMainFallback: Settings = {
      ...base,
      graphGleaningEnabled: false,
      modelProfiles: [localProfile], // no graphGleaningEnabled of its own
      roleProfiles: { knowledgeGraph: 'p1' },
    };
    expect(resolveModelForRole(withMainFallback, 'knowledgeGraph').graphGleaningEnabled).toBe(false);

    const withNeither: Settings = { ...base, modelProfiles: [localProfile], roleProfiles: { knowledgeGraph: 'p1' } };
    expect(resolveModelForRole(withNeither, 'knowledgeGraph').graphGleaningEnabled).toBeUndefined();
  });

  it('resolves graphExtractionStrategy/graphContextBefore/graphContextAfter the same profile-overrides-main-falls-back way', () => {
    const profileOverride: ModelProfile = {
      ...localProfile,
      graphExtractionStrategy: 'sentence',
      graphContextBefore: 2,
      graphContextAfter: 0,
    };
    const settings: Settings = { ...base, modelProfiles: [profileOverride], roleProfiles: { knowledgeGraph: 'p1' } };
    const resolved = resolveModelForRole(settings, 'knowledgeGraph');
    expect(resolved.graphExtractionStrategy).toBe('sentence');
    expect(resolved.graphContextBefore).toBe(2);
    expect(resolved.graphContextAfter).toBe(0);

    const withNeither: Settings = { ...base, modelProfiles: [localProfile], roleProfiles: { knowledgeGraph: 'p1' } };
    const resolvedNeither = resolveModelForRole(withNeither, 'knowledgeGraph');
    expect(resolvedNeither.graphExtractionStrategy).toBeUndefined();
    expect(resolvedNeither.graphContextBefore).toBeUndefined();
    expect(resolvedNeither.graphContextAfter).toBeUndefined();
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

  it('uses an explicitly assigned Knowledge Graph profile', () => {
    const settings: Settings = {
      ...base,
      modelProfiles: [localProfile, cloudProfile],
      roleProfiles: { utility: 'p1', knowledgeGraph: 'p2' },
    };
    expect(resolveModelForRole(settings, 'knowledgeGraph').model).toBe(cloudProfile.model);
  });

  it('inherits Utility when Knowledge Graph is unassigned', () => {
    const settings: Settings = { ...base, modelProfiles: [localProfile], roleProfiles: { utility: 'p1' } };
    expect(resolveModelForRole(settings, 'knowledgeGraph').model).toBe(localProfile.model);
  });

  it('falls back to main when neither Knowledge Graph nor Utility is assigned', () => {
    expect(resolveModelForRole(base, 'knowledgeGraph')).toBe(base);
  });

  it('does not silently inherit Utility when an explicit Knowledge Graph mapping is invalid', () => {
    const settings: Settings = {
      ...base,
      modelProfiles: [localProfile],
      roleProfiles: { utility: 'p1', knowledgeGraph: 'missing' },
    };
    expect(resolveModelForRole(settings, 'knowledgeGraph')).toBe(settings);
  });

  it('does not silently inherit Utility when an explicit Knowledge Graph profile is privacy-gated', () => {
    const settings: Settings = {
      ...base,
      restrictBackgroundToLocal: true,
      modelProfiles: [localProfile, cloudProfile],
      roleProfiles: { utility: 'p1', knowledgeGraph: 'p2' },
    };
    expect(resolveModelForRole(settings, 'knowledgeGraph')).toBe(settings);
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
