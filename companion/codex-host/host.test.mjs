import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createHost, encodeNativeMessage, readNativeMessages, validateRequest } from './host.mjs';

class FakeBackend extends EventEmitter {
  calls = [];
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'hello' } });
        this.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'hello' } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1', turn: { status: 'completed' } } });
      });
      return { turn: { id: 'turn-1' } };
    }
    return {};
  }
}

test('native framing handles split and adjacent messages', async () => {
  const bytes = Buffer.concat([encodeNativeMessage({ a: 1 }), encodeNativeMessage({ b: 2 })]);
  const stream = Readable.from([bytes.subarray(0, 3), bytes.subarray(3, 11), bytes.subarray(11)]);
  const messages = [];
  for await (const message of readNativeMessages(stream)) messages.push(message);
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
});

test('validation rejects extra fields, tokens, and oversized input', () => {
  assert.throws(() => validateRequest({ id: '1', op: 'accountStatus', params: { accessToken: 'secret' } }), /Unexpected params/);
  assert.throws(() => validateRequest({ id: '1', op: 'complete', params: {
    messages: [{ role: 'user', content: 'x'.repeat(256 * 1024 + 1) }],
  } }), /too large/);
  assert.throws(() => validateRequest({ id: '../bad', op: 'listModels', params: {} }), /request id/);
});

test('completion streams text and enforces transient read-only operation', async () => {
  const backend = new FakeBackend();
  const output = [];
  const host = createHost(backend, (message) => output.push(message));
  await host.handle({ id: 'request-1', op: 'complete', params: {
    model: 'codex-model',
    messages: [{ role: 'user', content: 'Say hello' }],
  } });

  assert.equal(output[0].event, 'delta');
  assert.deepEqual(output.at(-1), { id: 'request-1', ok: true, result: { text: 'hello' } });
  const start = backend.calls.find((call) => call.method === 'thread/start');
  const turn = backend.calls.find((call) => call.method === 'turn/start');
  assert.equal(start.params.sandbox, 'readOnly');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
  assert.equal(turn.params.sandboxPolicy.access.type, 'restricted');
  assert.equal(backend.calls.at(-1).method, 'thread/delete');
});

test('account status returns only allowlisted fields', async () => {
  const backend = new FakeBackend();
  backend.request = async () => ({
    account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro', accessToken: 'never-return-this' },
    requiresOpenaiAuth: true,
  });
  const output = [];
  await createHost(backend, (message) => output.push(message)).handle({ id: 'status-1', op: 'accountStatus', params: {} });
  assert.deepEqual(output[0].result.account, { type: 'chatgpt', email: 'person@example.test', planType: 'pro' });
  assert.equal(JSON.stringify(output).includes('never-return-this'), false);
});

test('quota returns only the documented primary rate-limit window', async () => {
  const backend = new FakeBackend();
  backend.request = async (method) => {
    assert.equal(method, 'account/rateLimits/read');
    return {
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1730947200 },
        rateLimitReachedType: null,
        credits: { balance: 999 },
      },
      secret: 'never-return-this',
    };
  };
  const output = [];
  await createHost(backend, (message) => output.push(message)).handle({ id: 'quota-1', op: 'quota', params: {} });
  assert.deepEqual(output[0].result, {
    available: true,
    usedPercent: 25,
    resetsAt: 1730947200,
    windowDurationMins: 15,
    limitName: 'Codex',
    reached: false,
  });
  assert.equal(JSON.stringify(output).includes('never-return-this'), false);
  assert.equal(JSON.stringify(output).includes('balance'), false);
});

test('abort interrupts an active turn', async () => {
  const backend = new EventEmitter();
  const calls = [];
  let releaseTurn;
  backend.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-abort' } };
    if (method === 'turn/start') return { turn: { id: 'turn-abort' } };
    if (method === 'turn/interrupt') {
      queueMicrotask(() => backend.emit('notification', {
        method: 'turn/completed',
        params: { threadId: 'thread-abort', turnId: 'turn-abort', turn: { status: 'interrupted' } },
      }));
      return {};
    }
    if (method === 'thread/delete') return {};
    return new Promise((resolve) => { releaseTurn = resolve; });
  };
  const output = [];
  const host = createHost(backend, (message) => output.push(message));
  const completion = host.handle({ id: 'long-request', op: 'complete', params: {
    messages: [{ role: 'user', content: 'Wait' }],
  } });
  await new Promise((resolve) => setImmediate(resolve));
  await host.handle({ id: 'abort-request', op: 'abort', params: { requestId: 'long-request' } });
  await completion;
  releaseTurn?.({});

  assert.equal(calls.some((call) => call.method === 'turn/interrupt'), true);
  assert.equal(output.some((message) => message.id === 'long-request' && message.error?.code === 'ABORTED'), true);
  assert.equal(output.some((message) => message.id === 'abort-request' && message.result?.aborted === true), true);
});
