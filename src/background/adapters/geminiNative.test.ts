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

  it('preserves a versioned OpenCode Zen base URL', () => {
    const req = geminiNativeAdapter.buildRequest(
      { ...settings, baseUrl: 'https://opencode.ai/zen/v1/', model: 'gemini-3.6-flash' },
      [{ role: 'user', content: 'hi' }],
    );
    expect(req.url).toBe('https://opencode.ai/zen/v1/models/gemini-3.6-flash:generateContent');
  });

  it('preserves an explicit v1beta base URL', () => {
    const req = geminiNativeAdapter.buildRequest(
      { ...settings, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/' },
      [{ role: 'user', content: 'hi' }],
    );
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent');
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

  it('returns Gemini thought signatures with function calls on the next turn', () => {
    const firstReply = geminiNativeAdapter.parseResponse({
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: 'get_active_tab', args: {} },
            thoughtSignature: 'opaque-signature',
          }],
        },
      }],
    });
    const req = geminiNativeAdapter.buildRequest(settings, [
      { role: 'user', content: 'Summarize this page.' },
      firstReply,
      { role: 'tool', tool_call_id: firstReply.tool_calls![0].id, content: '{"title":"Example"}' },
    ]);
    const body = req.body as { contents: Array<{ role: string; parts: unknown[] }> };

    expect(firstReply.tool_calls?.[0].thoughtSignature).toBe('opaque-signature');
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [{
        functionCall: { name: 'get_active_tab', args: {} },
        thoughtSignature: 'opaque-signature',
      }],
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
    expect(() => geminiNativeAdapter.parseResponse({ candidates: [] })).toThrow('Gemini returned no candidates.');
  });

  it('explains when the output token limit is reached before visible content', () => {
    expect(() => geminiNativeAdapter.parseResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toThrow(
      'Increase Max tokens and retry.',
    );
  });

  it('reports prompt safety blocks', () => {
    expect(() => geminiNativeAdapter.parseResponse({
      promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'Blocked by policy.' },
    })).toThrow('Gemini blocked the prompt (SAFETY): Blocked by policy.');
  });
});
