import { describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types';
import type { LlmMessage } from '../llmTypes';
import { openaiChatAdapter } from './openaiChat';

const settings: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt' };

describe('openaiChatAdapter.buildRequest', () => {
  it('builds the /chat/completions request body verbatim', () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'hi' }];
    const req = openaiChatAdapter.buildRequest(settings, messages);
    expect(req.url).toBe('https://api.example.com/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer sk-test');
    expect(req.body).toEqual({ model: 'gpt', messages });
  });

  it('includes tools when provided', () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', description: 'd', parameters: {} } }];
    const req = openaiChatAdapter.buildRequest(settings, [], tools);
    expect((req.body as { tools: unknown }).tools).toEqual(tools);
  });
});

describe('openaiChatAdapter.parseResponse', () => {
  it('extracts choices[0].message', () => {
    const message = openaiChatAdapter.parseResponse({ choices: [{ message: { role: 'assistant', content: 'hi' } }] });
    expect(message).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('throws when there is no message', () => {
    expect(() => openaiChatAdapter.parseResponse({ choices: [] })).toThrow();
  });
});
