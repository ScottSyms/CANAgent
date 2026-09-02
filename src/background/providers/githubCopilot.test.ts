import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubCopilotProvider } from './githubCopilot';
import { loadToken } from './tokenStore';

function makeArea() {
  const store: Record<string, unknown> = {};
  return {
    store,
    api: {
      async get(key: string) {
        return key in store ? { [key]: store[key] } : {};
      },
      async set(obj: Record<string, unknown>) {
        Object.assign(store, obj);
      },
      async remove(key: string) {
        delete store[key];
      },
    },
  };
}

let local: ReturnType<typeof makeArea>;

async function setClientId(id: string) {
  await local.api.set({ ba_settings: { githubCopilotClientId: id } });
}

function installNativePort(onRequest: (message: { id: string; op: string; params?: Record<string, unknown> }, respond: (message: unknown) => void) => void) {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port = {
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    postMessage(message: { id: string; op: string; params?: Record<string, unknown> }) {
      onRequest(message, (response) => messageListeners.forEach((listener) => listener(response)));
    },
    disconnect() {
      disconnectListeners.forEach((listener) => listener());
    },
  };
  vi.stubGlobal('chrome', { storage: { local: local.api }, runtime: { connectNative: () => port } });
}

beforeEach(() => {
  local = makeArea();
  vi.stubGlobal('chrome', { storage: { local: local.api } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GitHubCopilotProvider.connect', () => {
  it('requires a configured Client ID', async () => {
    const provider = new GitHubCopilotProvider();
    await expect(provider.connect()).rejects.toThrow(/Client ID/i);
  });

  it('requests a device code and returns the verification info', async () => {
    await setClientId('client-123');
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ device_code: 'dc1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GitHubCopilotProvider();
    const result = await provider.connect();
    expect(result).toEqual({ verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234' });
    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain('client_id=client-123');
  });

  it('surfaces a device-code request failure', async () => {
    await setClientId('client-123');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 })),
    );
    const provider = new GitHubCopilotProvider();
    await expect(provider.connect()).rejects.toThrow(/invalid_client/);
  });
});

describe('GitHubCopilotProvider.completeOAuthCallback (device polling)', () => {
  it('keeps polling through authorization_pending and stores tokens on success', async () => {
    vi.useFakeTimers();
    await setClientId('client-123');
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ device_code: 'dc1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'gho_final', token_type: 'bearer', scope: '' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitHubCopilotProvider();
    await provider.connect();
    const completion = provider.completeOAuthCallback();
    await vi.advanceTimersByTimeAsync(5000); // first poll -> pending
    await vi.advanceTimersByTimeAsync(5000); // second poll -> success
    await completion;

    const stored = await loadToken('github-copilot');
    expect(stored?.accessToken).toBe('gho_final');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops and throws on access_denied', async () => {
    vi.useFakeTimers();
    await setClientId('client-123');
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ device_code: 'dc1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'access_denied', error_description: 'User declined.' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitHubCopilotProvider();
    await provider.connect();
    const completion = provider.completeOAuthCallback();
    const assertion = expect(completion).rejects.toThrow(/declined/i);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('throws if called before connect()', async () => {
    const provider = new GitHubCopilotProvider();
    await expect(provider.completeOAuthCallback()).rejects.toThrow(/no sign-in in progress/i);
  });
});

describe('GitHubCopilotProvider disconnect / status', () => {
  it('disconnect clears the stored token without a network call', async () => {
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_x' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GitHubCopilotProvider();
    await provider.disconnect();
    expect(await loadToken('github-copilot')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports disconnected with no token, connected with a fresh token', async () => {
    const provider = new GitHubCopilotProvider();
    expect((await provider.getConnectionStatus()).status).toBe('disconnected');
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_x' });
    expect((await provider.getConnectionStatus()).status).toBe('connected');
  });

  it('reports expired when the token has no refresh token and is past expiry', async () => {
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_x', expiresAt: Date.now() - 1000 });
    const provider = new GitHubCopilotProvider();
    expect((await provider.getConnectionStatus()).status).toBe('expired');
  });
});

describe('GitHubCopilotProvider token refresh', () => {
  it('deduplicates concurrent refreshes and stores the rotated refresh token', async () => {
    const { saveToken } = await import('./tokenStore');
    await setClientId('client-123');
    await saveToken('github-copilot', {
      accessToken: 'gho_old',
      refreshToken: 'ghr_old',
      expiresAt: Date.now() - 1,
    });
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GitHubCopilotProvider();
    const first = provider.refreshAuthentication();
    const second = provider.refreshAuthentication();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({
      access_token: 'gho_new',
      refresh_token: 'ghr_new',
      expires_in: 28800,
      token_type: 'bearer',
    }), { status: 200 }));
    await Promise.all([first, second]);
    expect((await loadToken('github-copilot'))?.refreshToken).toBe('ghr_new');
  });
});

describe('GitHubCopilotProvider.getAccountInfo', () => {
  it('redacts the token from a thrown error on failure', async () => {
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_supersecrettoken' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('Bearer gho_supersecrettoken invalid', { status: 401 })),
    );
    const provider = new GitHubCopilotProvider();
    let threw = false;
    try {
      await provider.getAccountInfo();
    } catch (err) {
      threw = true;
      expect(String(err)).not.toContain('gho_supersecrettoken');
    }
    expect(threw).toBe(true);
  });

  it('returns the account label from /user', async () => {
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_x' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ login: 'octocat', name: 'The Octocat' }), { status: 200 })),
    );
    const provider = new GitHubCopilotProvider();
    const info = await provider.getAccountInfo();
    expect(info?.label).toBe('The Octocat');
    expect(info?.login).toBe('octocat');
  });
});

describe('GitHubCopilotProvider companion requests', () => {
  it('includes the stored access token when listing models', async () => {
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_models' });
    installNativePort((request, respond) => {
      expect(request.op).toBe('listModels');
      expect(request.params).toEqual({ accessToken: 'gho_models' });
      respond({ id: request.id, ok: true, result: { models: [{ id: 'gpt-5', label: 'GPT-5' }] } });
    });
    const provider = new GitHubCopilotProvider();
    await expect(provider.listModels()).resolves.toEqual([{ id: 'gpt-5', label: 'GPT-5' }]);
  });

  it('preserves message roles in completion requests', async () => {
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_complete' });
    const messages = [
      { role: 'system' as const, content: 'Be concise.' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
      { role: 'user' as const, content: 'Continue' },
    ];
    installNativePort((request, respond) => {
      expect(request.params?.messages).toEqual(messages);
      respond({ id: request.id, ok: true, result: { text: 'Response' } });
    });
    const provider = new GitHubCopilotProvider();
    await expect(provider.streamResponse({ messages }, vi.fn())).resolves.toBe('Response');
  });

  it('disconnects and rejects with AbortError when the request signal aborts', async () => {
    const { saveToken } = await import('./tokenStore');
    await saveToken('github-copilot', { accessToken: 'gho_abort' });
    installNativePort(() => {});
    const provider = new GitHubCopilotProvider();
    const controller = new AbortController();
    const completion = provider.streamResponse(
      { messages: [{ role: 'user', content: 'Wait' }], signal: controller.signal },
      vi.fn(),
    );
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
  });
});
