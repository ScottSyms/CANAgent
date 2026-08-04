import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('readTabGroup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('returns structured full page records so runtime owns truncation and citation registration', async () => {
    const longText = 'Sentence from the page. '.repeat(400);
    vi.stubGlobal('chrome', {
      tabGroups: { query: vi.fn(async () => [{ id: 7, title: 'Wolf' }]) },
      tabs: {
        query: vi.fn(async ({ groupId }: { groupId?: number }) => groupId === 7
          ? [{ id: 1, url: 'https://one.example.com', title: 'One' }, { id: 2, url: 'https://two.example.com', title: 'Two' }]
          : []),
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: `https://${tabId === 1 ? 'one' : 'two'}.example.com`,
          title: tabId === 1 ? 'One' : 'Two',
        })),
        sendMessage: vi.fn(async (_tabId: number, request: { kind: string }) => request.kind === 'ba_ping'
          ? { ok: true }
          : {
              url: `https://${_tabId === 1 ? 'one' : 'two'}.example.com`,
              title: _tabId === 1 ? 'One' : 'Two',
              text: longText,
              metadata: {},
              links: [],
              headings: [],
              extractionStatus: 'ok',
              capturedAt: '2026-08-04T00:00:00.000Z',
            }),
      },
      scripting: { executeScript: vi.fn(async () => []) },
    });
    const { readTabGroup } = await import('./browserToolAdapter');

    const result = await readTabGroup('Wolf', null);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(2);
    expect(result.results?.[0].text).toBe(longText);
    expect(result.results?.[0].text.length).toBeGreaterThan(6000);
  });
});
