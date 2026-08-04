import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedLocal, repoSearch } from './offscreenClient';

function stubHungOffscreen(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      getContexts: vi.fn(async () => [{}]),
      sendMessage: vi.fn(() => new Promise(() => {})),
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
      closeDocument: vi.fn(async () => {}),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offscreen cancellation', () => {
  it('releases a repository search when its task is stopped', async () => {
    stubHungOffscreen();
    const controller = new AbortController();
    const search = repoSearch('agreements', [1, 0], 6, 'local:test', { signal: controller.signal });

    controller.abort(new DOMException('Stopped', 'AbortError'));

    await expect(search).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('releases a local embedding request when its task is stopped', async () => {
    stubHungOffscreen();
    const controller = new AbortController();
    const embedding = embedLocal(['vacation entitlement'], 'test', controller.signal);

    controller.abort(new DOMException('Stopped', 'AbortError'));

    await expect(embedding).rejects.toMatchObject({ name: 'AbortError' });
  });
});
