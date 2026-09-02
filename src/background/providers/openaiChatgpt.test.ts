import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiChatGptProvider } from './openaiChatgpt';

function makePort() {
  let message: (value: unknown) => void = () => {};
  let disconnect: () => void = () => {};
  const port = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (fn: (value: unknown) => void) => { message = fn; } },
    onDisconnect: { addListener: (fn: () => void) => { disconnect = fn; } },
  };
  return { port, message: (value: unknown) => message(value), disconnected: () => disconnect() };
}

let native: ReturnType<typeof makePort>;

beforeEach(() => {
  native = makePort();
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { connectNative: vi.fn(() => native.port), lastError: undefined },
    storage: { local: {
      get: vi.fn(async (key: string) => key in store ? { [key]: store[key] } : {}),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(store, value); }),
      remove: vi.fn(async (key: string) => { delete store[key]; }),
    } },
  });
});

afterEach(() => vi.unstubAllGlobals());

function answer(result: unknown) {
  const sent = native.port.postMessage.mock.calls.at(-1)?.[0] as { id: string };
  native.message({ id: sent.id, ok: true, result });
}

describe('OpenAiChatGptProvider Codex companion', () => {
  it('connects only when the official Codex runtime reports a signed-in account', async () => {
    const provider = new OpenAiChatGptProvider();
    const connected = provider.connect();
    answer({ signedIn: true, account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' } });
    await expect(connected).resolves.toBeUndefined();
  });

  it('does not expose Codex credentials through account information', async () => {
    const provider = new OpenAiChatGptProvider();
    const infoPromise = provider.getAccountInfo();
    await vi.waitFor(() => expect(native.port.postMessage).toHaveBeenCalled());
    answer({ signedIn: true, account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' } });
    await expect(infoPromise).resolves.toMatchObject({ label: 'person@example.test', plan: 'pro' });
  });

  it('lists models through app-server without an OAuth token parameter', async () => {
    const provider = new OpenAiChatGptProvider();
    const modelsPromise = provider.listModels();
    await vi.waitFor(() => expect(native.port.postMessage).toHaveBeenCalled());
    const sent = native.port.postMessage.mock.calls.at(-1)?.[0] as { params: unknown };
    expect(sent.params).toEqual({});
    answer({ models: [{ id: 'codex-model', label: 'Codex Model' }] });
    await expect(modelsPromise).resolves.toEqual([{ id: 'codex-model', label: 'Codex Model' }]);
  });

  it('normalizes streamed deltas and the final response', async () => {
    const provider = new OpenAiChatGptProvider();
    const events: string[] = [];
    const response = provider.streamResponse(
      { messages: [{ role: 'user', content: 'hello' }] },
      (event) => events.push(`${event.type}:${'text' in event ? event.text : ''}`),
    );
    const sent = native.port.postMessage.mock.calls.at(-1)?.[0] as { id: string };
    native.message({ id: sent.id, event: 'delta', text: 'hel' });
    native.message({ id: sent.id, event: 'delta', text: 'lo' });
    native.message({ id: sent.id, ok: true, result: { text: 'hello' } });
    await expect(response).resolves.toBe('hello');
    expect(events).toEqual(['delta:hel', 'delta:lo', 'done:hello']);
  });

  it('maps the official Codex primary rate-limit window', async () => {
    const provider = new OpenAiChatGptProvider();
    const quotaPromise = provider.getQuotaStatus();
    await vi.waitFor(() => expect(native.port.postMessage).toHaveBeenCalled());
    answer({ available: true, usedPercent: 25, resetsAt: 1730947200, windowDurationMins: 15 });
    await expect(quotaPromise).resolves.toMatchObject({ available: true, used: 25, limit: 100 });
  });

  it('disconnects CANChat without deleting or importing Codex credentials', async () => {
    const provider = new OpenAiChatGptProvider();
    await provider.disconnect();
    expect((await provider.getConnectionStatus()).status).toBe('disconnected');
    expect(native.port.postMessage).not.toHaveBeenCalled();
  });
});
