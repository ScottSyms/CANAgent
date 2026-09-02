#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_REQUEST';
  return error;
}

export function validateRequest(value) {
  if (!isObject(value) || !exactKeys(value, ['id', 'op', 'params'])) throw invalid('Invalid request envelope');
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) throw invalid('Invalid request id');
  if (!['listModels', 'accountStatus', 'quota', 'complete', 'abort'].includes(value.op)) throw invalid('Unknown operation');
  const params = value.params ?? {};
  if (!isObject(params)) throw invalid('Invalid params');

  if (value.op === 'listModels' || value.op === 'accountStatus' || value.op === 'quota') {
    if (!exactKeys(params, [])) throw invalid('Unexpected params');
  } else if (value.op === 'abort') {
    if (!exactKeys(params, ['requestId']) || typeof params.requestId !== 'string' || !ID_PATTERN.test(params.requestId)) {
      throw invalid('Invalid abort request');
    }
  } else {
    if (!exactKeys(params, ['messages', 'model']) || !Array.isArray(params.messages) || params.messages.length < 1 || params.messages.length > 100) {
      throw invalid('Invalid completion request');
    }
    if (params.model !== undefined && (typeof params.model !== 'string' || params.model.length < 1 || params.model.length > 128)) {
      throw invalid('Invalid model');
    }
    let bytes = 0;
    for (const message of params.messages) {
      if (!isObject(message) || !exactKeys(message, ['role', 'content']) ||
          !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
        throw invalid('Invalid message');
      }
      bytes += Buffer.byteLength(message.content, 'utf8');
    }
    if (bytes > MAX_PROMPT_BYTES) throw invalid('Prompt is too large');
  }
  return { id: value.id, op: value.op, params };
}

export async function* readNativeMessages(stream, maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > maxBytes) throw invalid('Native message has invalid size');
      if (buffer.length < length + 4) break;
      const body = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      try {
        yield JSON.parse(body.toString('utf8'));
      } catch {
        throw invalid('Native message is not valid JSON');
      }
    }
  }
  if (buffer.length !== 0) throw invalid('Truncated native message');
}

export function encodeNativeMessage(message, maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxBytes) throw new Error('Native response is too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function safeError(error) {
  const code = error?.code;
  if (code === 'INVALID_REQUEST') return { code, message: error.message };
  if (code === 'ABORTED') return { code, message: 'Request cancelled' };
  if (code === 'CODEX_UNAVAILABLE') return { code, message: 'The local Codex app-server is unavailable' };
  if (code === 'AUTH_REQUIRED') return { code, message: 'Codex is not signed in; run npx codex login' };
  return { code: 'CODEX_ERROR', message: 'Codex could not complete the request' };
}

function promptFromMessages(messages) {
  return messages.map(({ role, content }) => `${role.toUpperCase()}:\n${content}`).join('\n\n');
}

export function createHost(backend, write) {
  const active = new Map();
  const inFlight = new Set();

  async function complete(id, params) {
    const state = { threadId: null, turnId: null, aborted: false };
    active.set(id, state);
    let full = '';
    let listener;
    try {
      const started = await backend.request('thread/start', {
        ...(params.model ? { model: params.model } : {}),
        cwd: HOST_DIR,
        approvalPolicy: 'never',
        sandbox: 'readOnly',
        serviceName: 'canchat_codex_host',
      });
      state.threadId = started?.thread?.id;
      if (typeof state.threadId !== 'string') throw new Error('Missing thread id');

      const completion = new Promise((resolve, reject) => {
        listener = (message) => {
          const event = message?.params;
          if (event?.threadId !== state.threadId || (state.turnId && event?.turnId && event.turnId !== state.turnId)) return;
          if (message.method === 'item/agentMessage/delta' && typeof event.delta === 'string') {
            full += event.delta;
            if (Buffer.byteLength(full, 'utf8') > MAX_RESPONSE_BYTES) {
              reject(new Error('Response too large'));
              return;
            }
            write({ id, event: 'delta', text: event.delta });
          } else if (message.method === 'item/completed' && event?.item?.type === 'agentMessage' && typeof event.item.text === 'string') {
            full = event.item.text;
          } else if (message.method === 'turn/completed') {
            if (event?.turn?.status === 'completed') resolve();
            else if (event?.turn?.status === 'interrupted') {
              const error = new Error('Cancelled');
              error.code = 'ABORTED';
              reject(error);
            } else reject(new Error('Turn failed'));
          }
        };
        backend.on('notification', listener);
      });

      const turn = await backend.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: promptFromMessages(params.messages) }],
        ...(params.model ? { model: params.model } : {}),
        cwd: HOST_DIR,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [HOST_DIR] },
        },
      });
      state.turnId = turn?.turn?.id;
      if (typeof state.turnId !== 'string') throw new Error('Missing turn id');
      if (state.aborted) await backend.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId });
      await completion;
      if (Buffer.byteLength(full, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Response too large');
      write({ id, ok: true, result: { text: full } });
    } finally {
      active.delete(id);
      if (listener) backend.off('notification', listener);
      if (state.threadId) await backend.request('thread/delete', { threadId: state.threadId }).catch(() => {});
    }
  }

  async function handle(raw) {
    let request;
    let registered = false;
    try {
      request = validateRequest(raw);
      const { id, op, params } = request;
      if (inFlight.has(id)) throw invalid('Request id is already in use');
      inFlight.add(id);
      registered = true;
      if (op === 'listModels') {
        const result = await backend.request('model/list', { limit: 100, includeHidden: false });
        const models = Array.isArray(result?.data) ? result.data : [];
        write({ id, ok: true, result: { models: models.map((model) => ({
          id: String(model.id ?? model.model),
          label: String(model.displayName ?? model.id ?? model.model),
          isDefault: model.isDefault === true,
        })).filter((model) => model.id !== 'undefined') } });
      } else if (op === 'accountStatus') {
        const result = await backend.request('account/read', { refreshToken: false });
        const account = result?.account;
        write({ id, ok: true, result: {
          signedIn: account !== null && account !== undefined,
          requiresOpenaiAuth: result?.requiresOpenaiAuth === true,
          account: account ? {
            type: typeof account.type === 'string' ? account.type : 'unknown',
            ...(typeof account.email === 'string' ? { email: account.email } : {}),
            ...(typeof account.planType === 'string' ? { planType: account.planType } : {}),
          } : null,
        } });
      } else if (op === 'quota') {
        const result = await backend.request('account/rateLimits/read', {});
        const limits = result?.rateLimits;
        const primary = limits?.primary;
        write({ id, ok: true, result: {
          available: typeof primary?.usedPercent === 'number',
          ...(typeof primary?.usedPercent === 'number' ? { usedPercent: primary.usedPercent } : {}),
          ...(typeof primary?.resetsAt === 'number' ? { resetsAt: primary.resetsAt } : {}),
          ...(typeof primary?.windowDurationMins === 'number' ? { windowDurationMins: primary.windowDurationMins } : {}),
          ...(typeof limits?.limitName === 'string' ? { limitName: limits.limitName } : {}),
          reached: limits?.rateLimitReachedType !== null && limits?.rateLimitReachedType !== undefined,
        } });
      } else if (op === 'abort') {
        const state = active.get(params.requestId);
        if (state) {
          state.aborted = true;
          if (state.threadId && state.turnId) await backend.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId });
        }
        write({ id, ok: true, result: { aborted: Boolean(state) } });
      } else {
        await complete(id, params);
      }
    } catch (error) {
      const safeId = typeof raw?.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : null;
      write({ id: request?.id ?? safeId, ok: false, error: safeError(error) });
    } finally {
      if (registered) inFlight.delete(request.id);
    }
  }

  return { handle };
}

export class CodexAppServer extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    const lines = readline.createInterface({ input: child.stdout });
    child.stderr.resume();
    lines.on('line', (line) => this.#receive(line));
    child.on('error', () => this.#failAll('CODEX_UNAVAILABLE'));
    child.on('exit', () => this.#failAll('CODEX_UNAVAILABLE'));
  }

  static async start(spawnImpl = spawn) {
    const localBinary = process.platform === 'win32'
      ? join(HOST_DIR, 'node_modules', '.bin', 'codex.cmd')
      : join(HOST_DIR, 'node_modules', '.bin', 'codex');
    try {
      await access(localBinary, fsConstants.X_OK);
    } catch {
      const error = new Error('Codex is not installed');
      error.code = 'CODEX_UNAVAILABLE';
      throw error;
    }
    const child = spawnImpl(localBinary, ['app-server'], { cwd: HOST_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    const server = new CodexAppServer(child);
    await server.request('initialize', {
      clientInfo: { name: 'canchat_codex_host', title: 'CANChat Codex Host', version: '0.1.0' },
    });
    server.notify('initialized', {});
    return server;
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error('Codex request failed'));
      else pending.resolve(message.result);
    } else if (typeof message.method === 'string') {
      this.emit('notification', message);
    }
  }

  #failAll(code) {
    for (const { reject } of this.pending.values()) {
      const error = new Error('Codex unavailable');
      error.code = code;
      reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.child.kill();
  }
}

async function main() {
  let backend;
  const write = (message) => process.stdout.write(encodeNativeMessage(message));
  try {
    backend = await CodexAppServer.start();
    const host = createHost(backend, write);
    for await (const message of readNativeMessages(process.stdin)) void host.handle(message);
  } finally {
    backend?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => process.exit(1));
}
