import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  MAX_FRAME_BYTES,
  buildPrompt,
  buildSessionConfig,
  copilotClientOptions,
  createRequestHandler,
  readMessages,
  validateRequest,
} from './host.mjs';

const token = 'github-token';

function completeRequest(overrides = {}) {
  return {
    id: 'request-1',
    op: 'complete',
    params: {
      accessToken: token,
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hello' }],
      ...overrides,
    },
  };
}

test('uses explicit token auth and empty SDK mode', () => {
  assert.deepEqual(copilotClientOptions(token), {
    gitHubToken: token,
    useLoggedInUser: false,
    mode: 'empty',
    baseDirectory: copilotClientOptions(token).baseDirectory,
  });
});

test('validates operations, credentials, roles, and prompt limits', () => {
  assert.throws(() => validateRequest({ id: '1', op: 'listModels', params: {} }), /accessToken/);
  assert.throws(() => validateRequest({ id: '1', op: 'other', params: { accessToken: token } }), /Unknown op/);
  assert.throws(() => validateRequest(completeRequest({ messages: [{ role: 'tool', content: 'x' }] })), /supported role/);
  assert.throws(
    () => validateRequest(completeRequest({ messages: [{ role: 'user', content: 'x'.repeat(128 * 1024 + 1) }] })),
    /size limit/,
  );
});

test('rejects oversized native frames before allocating their body', async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1);
  await assert.rejects(async () => {
    for await (const ignored of readMessages(Readable.from([header]))) void ignored;
  }, /Invalid native message length/);
});

test('keeps system, user, and assistant roles distinct using supported SDK fields', () => {
  const messages = [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Question one' },
    { role: 'assistant', content: 'Answer one' },
    { role: 'user', content: 'Question two' },
  ];
  assert.deepEqual(buildSessionConfig(messages, 'gpt-5'), {
    model: 'gpt-5',
    availableTools: [],
    streaming: true,
    systemMessage: { mode: 'append', content: 'Be concise.' },
  });
  assert.deepEqual(JSON.parse(buildPrompt(messages).split('\n')[1]), messages.slice(1));
});

test('listModels uses the request token and returns normalized models', async () => {
  const writes = [];
  let receivedToken;
  const handle = createRequestHandler({
    createClient: async (accessToken) => {
      receivedToken = accessToken;
      return { listModels: async () => [{ id: 'gpt-5', name: 'GPT-5' }], stop: async () => [] };
    },
    write: (message) => writes.push(message),
  });
  await handle({ id: 'models', op: 'listModels', params: { accessToken: token } });
  assert.equal(receivedToken, token);
  assert.deepEqual(writes, [{ id: 'models', ok: true, result: { models: [{ id: 'gpt-5', label: 'GPT-5' }] } }]);
});

test('streams SDK deltas and uses the final assistant message', async () => {
  const writes = [];
  let deltaHandler;
  const session = {
    on(type, handler) {
      assert.equal(type, 'assistant.message_delta');
      deltaHandler = handler;
      return () => {};
    },
    async sendAndWait({ prompt }) {
      assert.equal(prompt, 'Hello');
      deltaHandler({ data: { deltaContent: 'Hi' } });
      return { data: { content: 'Hi there' } };
    },
    async disconnect() {},
    async abort() {},
  };
  const handle = createRequestHandler({
    createClient: async () => ({ createSession: async () => session, stop: async () => [] }),
    write: (message) => writes.push(message),
  });
  await handle(completeRequest());
  assert.deepEqual(writes, [
    { id: 'request-1', event: 'delta', text: 'Hi' },
    { id: 'request-1', ok: true, result: { text: 'Hi there' } },
  ]);
});

test('aborts a session when completion times out', async () => {
  const writes = [];
  let aborted = false;
  const session = {
    on: () => () => {},
    sendAndWait: async () => new Promise(() => {}),
    abort: async () => { aborted = true; },
    disconnect: async () => {},
  };
  const handle = createRequestHandler({
    createClient: async () => ({ createSession: async () => session, stop: async () => [] }),
    write: (message) => writes.push(message),
    completionTimeoutMs: 5,
  });
  await handle(completeRequest());
  assert.equal(aborted, true);
  assert.match(writes[0].error, /timed out/);
});

test('aborts an active session when the native connection closes', async () => {
  const writes = [];
  let aborted = false;
  const session = {
    on: () => () => {},
    sendAndWait: async () => new Promise(() => {}),
    abort: async () => { aborted = true; },
    disconnect: async () => {},
  };
  const handle = createRequestHandler({
    createClient: async () => ({ createSession: async () => session, stop: async () => [] }),
    write: (message) => writes.push(message),
    completionTimeoutMs: 1000,
  });
  const controller = new AbortController();
  const pending = handle(completeRequest(), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await pending;
  assert.equal(aborted, true);
  assert.match(writes[0].error, /aborted/);
});
