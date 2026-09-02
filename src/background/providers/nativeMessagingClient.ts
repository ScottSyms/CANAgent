// =============================================================================
// Generic native-messaging client for a `local_companion`-decision provider.
// Wraps chrome.runtime.connectNative in a small request/response protocol
// (correlated by `id`) so a provider module can `await request(...)` instead
// of hand-rolling port listeners. Used today by providers/githubCopilot.ts to
// reach a locally-installed companion that runs GitHub's own Copilot
// SDK/CLI — see companion/github-copilot-host/ for the reference host and
// docs/providers.md for installation.
//
// The extension NEVER receives a subprocess handle or spawns anything itself
// (a service worker cannot); it only exchanges JSON messages over the native
// messaging port, which Chrome itself brokers to a host process registered
// via an OS-level native-messaging manifest the user installs once.
// =============================================================================

export interface NativeHostRequest {
  id: string;
  op: string;
  params?: Record<string, unknown>;
}

export type NativeHostResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: string }
  | { id: string; event: 'delta'; text: string };

export class NativeCompanionClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    onDelta?: (text: string) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
  }>();

  constructor(private readonly hostName: string) {}

  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port;
    if (!chrome.runtime.connectNative) {
      throw new Error('Native messaging is unavailable in this browser build.');
    }
    const port = chrome.runtime.connectNative(this.hostName);
    port.onMessage.addListener((msg: NativeHostResponse) => this.handleMessage(msg));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? 'Native companion disconnected.';
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        if (p.signal && p.abort) p.signal.removeEventListener('abort', p.abort);
        p.reject(new Error(err));
      }
      this.pending.clear();
      this.port = null;
    });
    this.port = port;
    return port;
  }

  private handleMessage(msg: NativeHostResponse): void {
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    if ('event' in msg && msg.event === 'delta') {
      waiter.onDelta?.(msg.text);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
    if ('ok' in msg && msg.ok) waiter.resolve(msg.result);
    else if ('ok' in msg) {
      const message = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
      waiter.reject(new Error(message));
    }
  }

  /** True only once a connection has been attempted and not yet torn down. Does not itself probe liveness. */
  get connected(): boolean {
    return this.port !== null;
  }

  async request(
    op: string,
    params?: Record<string, unknown>,
    onDelta?: (text: string) => void,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    const port = this.ensurePort();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
        reject(new Error(`Native companion request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      const abort = () => {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        reject(new DOMException('The request was aborted.', 'AbortError'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, onDelta, timer, signal: options.signal, abort });
      try {
        port.postMessage({ id, op, params } satisfies NativeHostRequest);
      } catch (err) {
        const waiter = this.pending.get(id);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener('abort', abort);
          this.pending.delete(id);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  disconnect(): void {
    this.port?.disconnect();
    this.port = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.signal && p.abort) p.signal.removeEventListener('abort', p.abort);
      p.reject(new Error('Disconnected.'));
    }
    this.pending.clear();
  }
}
