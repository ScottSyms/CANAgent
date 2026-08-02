import { describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types';
import type { LlmMessage } from '../llmTypes';
import { geminiNativeAdapter } from './geminiNative';

const settings: Settings = { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'AIza-test', model: 'gemini-3-flash' };

describe('geminiNativeAdapter.buildRequest', () => {
  it('builds the model-in-path URL and x-goog-api-key header', () => {
    const req = geminiNativeAdapter.buildRequest(settings, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent');
    expect(req.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('pulls the system message into systemInstruction and maps assistant -> model role', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ];
    const req = geminiNativeAdapter.buildRequest(settings, messages);
    const body = req.body as { systemInstruction: unknown; contents: Array<{ role: string; parts: unknown }> };
    expect(body.systemInstruction).toEqual({ role: 'user', parts: [{ text: 'be helpful' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello!' }] },
    ]);
  });

  it('maps a tool_call to a functionCall part and a tool result to a functionResponse part resolved by name', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'weather in SF?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_0_get_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_0_get_weather', content: '72F sunny' },
    ];
    const req = geminiNativeAdapter.buildRequest(settings, messages);
    const body = req.body as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(body.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] });
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { result: '72F sunny' } } }],
    });
  });

  it('maps a data-url image part to inlineData', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ];
    const req = geminiNativeAdapter.buildRequest(settings, messages);
    const body = req.body as { contents: Array<{ parts: unknown[] }> };
    expect(body.contents[0].parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]);
  });

  it('translates tools into a single functionDeclarations tool entry, stripping additionalProperties', () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      },
    ];
    const req = geminiNativeAdapter.buildRequest(settings, [{ role: 'user', content: 'hi' }], tools);
    expect((req.body as { tools: unknown }).tools).toEqual([
      { functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }] },
    ]);
  });
});

describe('geminiNativeAdapter.parseResponse', () => {
  it('concatenates text parts', () => {
    const message = geminiNativeAdapter.parseResponse({
      candidates: [{ content: { parts: [{ text: 'hello' }] } }],
    });
    expect(message).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('extracts functionCall parts as tool_calls with an invented id', () => {
    const message = geminiNativeAdapter.parseResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] } }],
    });
    expect(message.tool_calls).toEqual([
      { id: 'call_0_get_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
  });

  it('throws when there are no candidates', () => {
    expect(() => geminiNativeAdapter.parseResponse({ candidates: [] })).toThrow();
  });
});
