import { describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types';
import { LlmError, type LlmMessage } from '../llmTypes';
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

  it('preserves tool-only assistant messages', () => {
    const message = openaiChatAdapter.parseResponse({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_repo', arguments: '{}' } }],
        },
      }],
    });
    expect(message.tool_calls?.[0].function.name).toBe('search_repo');
  });

  it('reports HTTP-200 OpenRouter choice errors with provider metadata', () => {
    let thrown: unknown;
    try {
      openaiChatAdapter.parseResponse({
        id: 'gen-123',
        model: 'google/gemini-3.6-flash',
        provider: 'Google',
        choices: [{
          finish_reason: 'error',
          message: { role: 'assistant', content: null },
          error: {
            code: 502,
            message: 'Provider disconnected',
            metadata: { error_type: 'provider_unavailable', provider_code: 'upstream_closed' },
          },
        }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    expect(thrown).toMatchObject({ retryable: true });
    expect((thrown as Error).message).toContain('provider_unavailable');
    expect((thrown as Error).message).toContain('Provider disconnected');
    expect((thrown as Error).message).toContain('generation gen-123');
    expect((thrown as Error).message).toContain('provider Google');
  });

  it('reports a length-limited empty completion without retrying it', () => {
    let thrown: unknown;
    try {
      openaiChatAdapter.parseResponse({
        choices: [{
          finish_reason: 'length',
          native_finish_reason: 'MAX_TOKENS',
          message: { role: 'assistant', content: null },
        }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ retryable: false });
    expect((thrown as Error).message).toContain('MAX_TOKENS');
    expect((thrown as Error).message).toContain('Increase Max tokens');
  });

  it('marks an otherwise empty completion as transient', () => {
    expect(() => openaiChatAdapter.parseResponse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }],
    })).toThrow(/no usable content.*stop/i);
  });
});
