import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCAL_EMBED_MODEL, type Settings } from '../shared/types';

// embedChunks routes the local path through the offscreen embedder; mock it so we
// can assert dispatch without a browser/transformers runtime.
const embedLocal = vi.fn();
vi.mock('./offscreenClient', () => ({ embedLocal: (...a: unknown[]) => embedLocal(...a) }));

import { embedChunks, embedderId } from './llmProvider';

const base: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt' };

afterEach(() => {
  vi.restoreAllMocks();
  embedLocal.mockReset();
});

describe('embedderId', () => {
  it('defaults to the local MiniLM model', () => {
    expect(embedderId(base)).toBe(`local:${DEFAULT_LOCAL_EMBED_MODEL}`);
  });

  it('honors a custom local model id', () => {
    expect(embedderId({ ...base, embedder: 'local', localEmbedModel: 'Xenova/bge-small-en' })).toBe(
      'local:Xenova/bge-small-en',
    );
  });

  it('uses the embedding model in external mode (falling back to the chat model)', () => {
    expect(embedderId({ ...base, embedder: 'external', embeddingModel: 'text-embedding-3-small' })).toBe(
      'external:text-embedding-3-small',
    );
    expect(embedderId({ ...base, embedder: 'external' })).toBe('external:gpt');
  });
});

describe('embedChunks dispatch', () => {
  it('routes to the on-device embedder by default', async () => {
    embedLocal.mockResolvedValue({ ok: true, vectors: [[1, 2, 3]], model: DEFAULT_LOCAL_EMBED_MODEL });
    const out = await embedChunks(base, ['hello']);
    expect(out).toEqual([[1, 2, 3]]);
    expect(embedLocal).toHaveBeenCalledWith(['hello'], DEFAULT_LOCAL_EMBED_MODEL);
  });

  it('throws a clear error when the local embedder fails', async () => {
    embedLocal.mockResolvedValue({ ok: false, error: 'model load failed' });
    await expect(embedChunks(base, ['x'])).rejects.toThrow(/Local embedder failed: model load failed/);
  });

  it('routes to the /embeddings endpoint in external mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [9, 8, 7] }] }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const out = await embedChunks({ ...base, embedder: 'external' }, ['q']);
    expect(out).toEqual([[9, 8, 7]]);
    expect(embedLocal).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/embeddings');
  });

  it('returns [] for no input without calling either backend', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await embedChunks(base, [])).toEqual([]);
    expect(embedLocal).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
