import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeCompanionClient } from './nativeMessagingClient';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void; fire: (msg: unknown) => void };
  onDisconnect: { addListener: (fn: () => void) => void; fire: () => void };
  disconnect: ReturnType<typeof vi.fn>;
}

function makeFakePort(): FakePort {
  let onMessageFn: (msg: unknown) => void = () => {};
  let onDisconnectFn: () => void = () => {};
  return {
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn) => {
        onMessageFn = fn;
      },
      fire: (msg) => onMessageFn(msg),
    },
    onDisconnect: {
      addListener: (fn) => {
        onDisconnectFn = fn;
      },
      fire: () => onDisconnectFn(),
    },
    disconnect: vi.fn(),
  };
}

let port: FakePort;
let connectNative: ReturnType<typeof vi.fn>;

beforeEach(() => {
  port = makeFakePort();
  connectNative = vi.fn(() => port);
  vi.stubGlobal('chrome', { runtime: { connectNative, lastError: undefined } });
});

describe('NativeCompanionClient', () => {
  it('connects lazily on the first request, reusing the same port after', async () => {
    const client = new NativeCompanionClient('com.example.host');
    expect(client.connected).toBe(false);
    const promise = client.request('ping');
    expect(connectNative).toHaveBeenCalledWith('com.example.host');
    expect(client.connected).toBe(true);
    const sent = port.postMessage.mock.calls[0][0] as { id: string; op: string };
    port.onMessage.fire({ id: sent.id, ok: true, result: 'pong' });
    await expect(promise).resolves.toBe('pong');

    const promise2 = client.request('ping2');
    expect(connectNative).toHaveBeenCalledTimes(1); // reused, not reconnected
    const sent2 = port.postMessage.mock.calls[1][0] as { id: string; op: string };
    port.onMessage.fire({ id: sent2.id, ok: true, result: 'pong2' });
    await expect(promise2).resolves.toBe('pong2');
  });

  it('correlates concurrent requests by id and resolves each independently', async () => {
    const client = new NativeCompanionClient('com.example.host');
    const p1 = client.request('op1');
    const p2 = client.request('op2');
    const [id1] = port.postMessage.mock.calls[0];
    const [id2] = port.postMessage.mock.calls[1];
    port.onMessage.fire({ id: (id2 as { id: string }).id, ok: true, result: 'second' });
    port.onMessage.fire({ id: (id1 as { id: string }).id, ok: true, result: 'first' });
    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('second');
  });

  it('rejects the matching request on an error response', async () => {
    const client = new NativeCompanionClient('com.example.host');
    const promise = client.request('op');
    const sent = port.postMessage.mock.calls[0][0] as { id: string };
    port.onMessage.fire({ id: sent.id, ok: false, error: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('delivers delta events to the onDelta callback without resolving the request', async () => {
    const client = new NativeCompanionClient('com.example.host');
    const deltas: string[] = [];
    const promise = client.request('complete', {}, (text) => deltas.push(text));
    const sent = port.postMessage.mock.calls[0][0] as { id: string };
    port.onMessage.fire({ id: sent.id, event: 'delta', text: 'hel' });
    port.onMessage.fire({ id: sent.id, event: 'delta', text: 'lo' });
    port.onMessage.fire({ id: sent.id, ok: true, result: { text: 'hello' } });
    expect(deltas).toEqual(['hel', 'lo']);
    await expect(promise).resolves.toEqual({ text: 'hello' });
  });

  it('rejects all pending requests when the port disconnects', async () => {
    const client = new NativeCompanionClient('com.example.host');
    const promise = client.request('op');
    port.onDisconnect.fire();
    await expect(promise).rejects.toThrow();
    expect(client.connected).toBe(false);
  });

  it('throws a clear error when native messaging is unavailable', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const client = new NativeCompanionClient('com.example.host');
    await expect(client.request('op')).rejects.toThrow(/native messaging is unavailable/i);
  });

  it('disconnect() tears down the port and rejects anything still pending', async () => {
    const client = new NativeCompanionClient('com.example.host');
    const promise = client.request('op');
    client.disconnect();
    await expect(promise).rejects.toThrow();
    expect(port.disconnect).toHaveBeenCalled();
    expect(client.connected).toBe(false);
  });

  it('rejects an aborted request without waiting for the companion', async () => {
    const client = new NativeCompanionClient('com.example.host');
    const controller = new AbortController();
    const promise = client.request('op', {}, undefined, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds requests with a timeout', async () => {
    vi.useFakeTimers();
    const client = new NativeCompanionClient('com.example.host');
    const promise = client.request('op', {}, undefined, { timeoutMs: 10 });
    const rejected = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    vi.useRealTimers();
  });
});
