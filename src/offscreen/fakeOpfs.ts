// Minimal in-memory OPFS fake (only the surface repoStore.ts uses), shared by
// repoStore.test.ts and ingestBenchmark.ts. The benchmark needs the exact same
// fake the tests already trust — timing a reimplementation would measure the
// wrong thing.

export class FakeWritable {
  constructor(
    private file: FakeFileHandle,
    keepExistingData: boolean,
  ) {
    if (!keepExistingData) file.bytes = new Uint8Array(0);
  }
  async write(
    input: string | BufferSource | { type: 'write'; position: number; data: string | BufferSource },
  ): Promise<void> {
    const toBytes = (d: string | BufferSource): Uint8Array =>
      typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d as ArrayBuffer);
    let position: number;
    let data: Uint8Array;
    if (input && typeof input === 'object' && 'type' in input) {
      position = input.position;
      data = toBytes(input.data);
    } else {
      position = this.file.bytes.length;
      data = toBytes(input as string | BufferSource);
    }
    const end = position + data.length;
    if (end > this.file.bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(this.file.bytes);
      this.file.bytes = grown;
    }
    this.file.bytes.set(data, position);
  }
  async close(): Promise<void> {}
}

export class FakeFileHandle {
  kind = 'file' as const;
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  async getFile() {
    const bytes = this.bytes;
    return {
      size: bytes.length,
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }
  async createWritable(opts?: { keepExistingData?: boolean }) {
    return new FakeWritable(this, opts?.keepExistingData ?? false);
  }
}

export class FakeDirHandle {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
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
    this.dirs.delete(name);
    this.files.delete(name);
  }
  async *entries(): AsyncGenerator<[string, FakeDirHandle | FakeFileHandle]> {
    for (const [n, d] of this.dirs) yield [n, d];
    for (const [n, f] of this.files) yield [n, f];
  }
}

/**
 * Stub `navigator.storage` (OPFS) and `chrome` (vault) directly on
 * `globalThis`, so repoStore.ts's module code runs unmodified whether the
 * caller is a Vitest suite (`environment: 'node'`, per vitest.config.ts — no
 * pre-existing `navigator`/`chrome` to conflict with) or a plain Node CLI
 * script (`scripts/ingest-benchmark.ts`, via `vite`'s `ssrLoadModule`, which
 * has no test-runner globals like `vi.stubGlobal` at all). An absent
 * `chrome.runtime` makes `vaultClient.ts`'s `getVaultState()` degrade to
 * `'none'` (see its own doc comment), i.e. no-vault/plaintext — the same
 * "empty storage" state `repoStore.test.ts`'s `chrome.storage` stub already
 * produces today.
 */
export function installFakeOpfs(): FakeDirHandle {
  const root = new FakeDirHandle('root');
  // Plain assignment fails for `navigator`: Node defines it globally as a
  // getter-only property, so it must be redefined via defineProperty (what
  // vi.stubGlobal does internally) rather than set directly.
  const stub = (key: 'navigator' | 'chrome', value: unknown) =>
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  stub('navigator', { storage: { getDirectory: async () => root } });
  stub('chrome', { storage: { local: fakeStorageArea(), session: fakeStorageArea() } });
  return root;
}

function fakeStorageArea() {
  return { async get() { return {}; }, async set() {}, async remove() {} };
}
