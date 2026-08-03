import { describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types';
import type { LlmMessage } from '../llmTypes';
import { openaiResponsesAdapter } from './openaiResponses';

const settings: Settings = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5.1' };

describe('openaiResponsesAdapter.buildRequest', () => {
  it('maps plain text messages to message input items', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ];
    const req = openaiResponsesAdapter.buildRequest(settings, messages);
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.Authorization).toBe('Bearer sk-test');
    expect(req.body).toMatchObject({
      model: 'gpt-5.1',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'be helpful' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    });
  });

  it('maps an assistant tool_call to a function_call item and a tool result to function_call_output', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'weather in SF?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '72F sunny' },
    ];
    const req = openaiResponsesAdapter.buildRequest(settings, messages);
    const input = (req.body as { input: unknown[] }).input;
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather in SF?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '72F sunny' },
    ]);
  });

  it('maps image content parts to input_image items', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ];
    const req = openaiResponsesAdapter.buildRequest(settings, messages);
    const input = (req.body as { input: Array<{ content: Array<{ type: string }> }> }).input;
    expect(input[0].content[0].type).toBe('input_image');
  });

  it('omits temperature for reasoning models that reject it', () => {
    const req = openaiResponsesAdapter.buildRequest(
      { ...settings, temperature: 0 },
      [{ role: 'user', content: 'hi' }],
    );
    expect(req.body).not.toHaveProperty('temperature');
  });
});

describe('openaiResponsesAdapter.parseResponse', () => {
  it('concatenates output_text parts from message items', () => {
    const message = openaiResponsesAdapter.parseResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    });
    expect(message).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('extracts function_call items as tool_calls', () => {
    const message = openaiResponsesAdapter.parseResponse({
      output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' }],
    });
    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
  });

  it('throws when output is empty', () => {
    expect(() => openaiResponsesAdapter.parseResponse({ output: [] })).toThrow();
  });
});
