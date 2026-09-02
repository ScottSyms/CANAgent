import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamResponse = vi.hoisted(() => vi.fn());
const getConnectionStatus = vi.hoisted(() => vi.fn());

vi.mock('./providers/registry', () => ({
  getProvider: () => ({
    id: 'github-copilot',
    capabilities: { tools: false, images: false, reasoning: true, streaming: true, authModes: ['local-companion'] },
    getConnectionStatus,
    streamResponse,
  }),
}));

import { complete } from './llmProvider';

describe('subscription model routing', () => {
  beforeEach(() => {
    getConnectionStatus.mockReset().mockResolvedValue({ status: 'connected' });
    streamResponse.mockReset().mockResolvedValue('subscription answer');
  });

  it('routes selected settings through the provider and normalizes tool history', async () => {
    const response = await complete(
      { baseUrl: '', apiKey: '', model: 'copilot-model', subscriptionProvider: 'github-copilot' },
      [
        { role: 'system', content: 'system' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'page text' },
      ],
    );

    expect(response).toEqual({ role: 'assistant', content: 'subscription answer' });
    expect(streamResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'copilot-model',
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: expect.stringContaining('page text') }),
        ]),
      }),
      expect.any(Function),
    );
  });

  it('fails closed when the provider is not connected', async () => {
    getConnectionStatus.mockResolvedValue({ status: 'disconnected', detail: 'Install the companion.' });
    await expect(complete(
      { baseUrl: '', apiKey: '', model: 'model', subscriptionProvider: 'github-copilot' },
      [{ role: 'user', content: 'hello' }],
    )).rejects.toThrow(/install the companion/i);
    expect(streamResponse).not.toHaveBeenCalled();
  });

  it('rejects unsupported image input before contacting the provider', async () => {
    await expect(complete(
      { baseUrl: '', apiKey: '', model: 'model', subscriptionProvider: 'github-copilot' },
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
    )).rejects.toThrow(/does not support image/i);
    expect(streamResponse).not.toHaveBeenCalled();
  });
});
