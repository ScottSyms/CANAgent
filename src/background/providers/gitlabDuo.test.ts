import { describe, expect, it } from 'vitest';
import { GitLabDuoProvider } from './gitlabDuo';

describe('GitLabDuoProvider blocked state', () => {
  it('does not start OAuth when Duo inference has not been sanctioned and verified', async () => {
    const provider = new GitLabDuoProvider();
    await expect(provider.connect()).rejects.toThrow(/inference transport/i);
  });

  it('reports an unsupported status without models or account data', async () => {
    const provider = new GitLabDuoProvider();
    expect((await provider.getConnectionStatus()).status).toBe('unsupported');
    expect(await provider.getAccountInfo()).toBeNull();
    expect(await provider.listModels()).toEqual([]);
  });

  it('refuses inference instead of calling the experimental GraphQL path', async () => {
    const provider = new GitLabDuoProvider();
    const events: string[] = [];
    await expect(
      provider.streamResponse({ messages: [{ role: 'user', content: 'hello' }] }, (event) => events.push(event.type)),
    ).rejects.toThrow(/aiAction\/aiMessages/i);
    expect(events).toEqual(['error']);
  });

  it('never invents quota information', async () => {
    const provider = new GitLabDuoProvider();
    expect((await provider.getQuotaStatus()).available).toBe(false);
  });
});
