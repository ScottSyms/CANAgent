import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from './audit';
import { appendAuditEvent, getAuditIndex, readAuditEvents } from './auditLog';

// ---- append-capable in-memory OPFS fake (positional write + keepExistingData) ----

class FakeWritable {
  private buf: number[];
  constructor(private file: FakeFileHandle, keep: boolean) {
    this.buf = keep ? [...file.bytes] : [];
  }
  async write(input: { type: string; position: number; data: BufferSource } | BufferSource): Promise<void> {
    const isCmd = typeof input === 'object' && input !== null && 'position' in input;
    const data = isCmd ? (input as { data: BufferSource }).data : (input as BufferSource);
    const position = isCmd ? (input as { position: number }).position : this.buf.length;
    const bytes = new Uint8Array(data as ArrayBuffer);
    for (let i = 0; i < bytes.length; i++) this.buf[position + i] = bytes[i];
  }
  async close(): Promise<void> {
    this.file.bytes = new Uint8Array(this.buf);
  }
}

class FakeFileHandle {
  kind = 'file' as const;
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  async getFile() {
    const bytes = this.bytes;
    return { size: bytes.length, async text() { return new TextDecoder().decode(bytes); } };
  }
  async createWritable(opts?: { keepExistingData?: boolean }) {
    return new FakeWritable(this, opts?.keepExistingData ?? false);
  }
}

class FakeDirHandle {
  files = new Map<string, FakeFileHandle>();
  dirs = new Map<string, FakeDirHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new Error('NotFound');
      d = new FakeDirHandle(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw new Error('NotFound');
      f = new FakeFileHandle(name);
      this.files.set(name, f);
    }
    return f;
  }
  async removeEntry(name: string) {
    this.files.delete(name);
  }
}

function installFakeStorage() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
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
    },
  });
}

function evt(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    conversationId: 'conv-1',
    eventType: 'TOOL_EXECUTED',
    ...overrides,
  };
}

beforeEach(() => {
  const root = new FakeDirHandle('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  installFakeStorage();
});

describe('audit log (OPFS JSONL + index)', () => {
  it('appends multiple events and reads them back oldest-first', async () => {
    await appendAuditEvent(evt({ tool: 'get_tab_content' }));
    await appendAuditEvent(evt({ tool: 'submit_form', eventType: 'APPROVAL_GRANTED' }));
    const events = await readAuditEvents('conv-1');
    expect(events).toHaveLength(2);
    expect(events[0].tool).toBe('get_tab_content');
    expect(events[1].eventType).toBe('APPROVAL_GRANTED');
  });

  it('advances the index counters per conversation', async () => {
    await appendAuditEvent(evt({ conversationId: 'conv-1' }));
    await appendAuditEvent(evt({ conversationId: 'conv-1' }));
    await appendAuditEvent(evt({ conversationId: 'conv-2' }));
    const index = await getAuditIndex();
    const a = index.find((e) => e.conversationId === 'conv-1');
    const b = index.find((e) => e.conversationId === 'conv-2');
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
    expect((a?.bytes ?? 0)).toBeGreaterThan(0);
  });

  it('returns [] for a conversation with no log', async () => {
    expect(await readAuditEvents('nope')).toEqual([]);
  });

  it('stores digests, never the underlying payload', async () => {
    await appendAuditEvent(evt({ inputDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64) }));
    const events = await readAuditEvents('conv-1');
    expect(events[0].inputDigest).toHaveLength(64);
    // sanity: no free-text args field exists on the event shape
    expect((events[0] as unknown as Record<string, unknown>).args).toBeUndefined();
  });
});
