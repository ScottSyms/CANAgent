import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getVaultState, lockVault, setupVault, unlockVault, vaultDecrypt, vaultEncrypt } from '../background/vault';
import { repoAdd, repoDocChunks, repoDocVectors, repoSearch } from './repoStore';

// ---- OPFS fake (positional writes + keepExistingData, same surface repoStore uses) ----

class FakeWritable {
  constructor(private file: FakeFileHandle, keep: boolean) {
    if (!keep) file.bytes = new Uint8Array(0);
  }
  async write(input: string | BufferSource | { type: 'write'; position: number; data: string | BufferSource }) {
    const toBytes = (d: string | BufferSource) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d as ArrayBuffer));
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
  async close() {}
}
class FakeFileHandle {
  kind = 'file' as const;
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  async getFile() {
    const bytes = this.bytes;
    return {
      size: bytes.length,
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  }
  async createWritable(opts?: { keepExistingData?: boolean }) { return new FakeWritable(this, opts?.keepExistingData ?? false); }
}
class FakeDirHandle {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) { if (!opts?.create) throw new Error('NotFound'); d = new FakeDirHandle(name); this.dirs.set(name, d); }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) { if (!opts?.create) throw new Error('NotFound'); f = new FakeFileHandle(name); this.files.set(name, f); }
    return f;
  }
  async removeEntry(name: string) { this.dirs.delete(name); this.files.delete(name); }
}

const vec = (n: number, seed: number): number[] => Array.from({ length: n }, (_, i) => Math.sin(seed + i) + 1.5);

// Persistent in-memory chrome.storage (local + session) so the vault works.
function makeArea() {
  const store: Record<string, unknown> = {};
  return {
    async get(key: string) { return key in store ? { [key]: store[key] } : {}; },
    async set(obj: Record<string, unknown>) { Object.assign(store, obj); },
    async remove(key: string) { delete store[key]; },
  };
}

let root: FakeDirHandle;
async function diskText(repo: string, file: string): Promise<string> {
  const bytes = root.dirs.get('repos')!.dirs.get(repo)!.files.get(file)!.bytes;
  return new TextDecoder().decode(bytes);
}

beforeEach(() => {
  root = new FakeDirHandle('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  // repoStore now delegates vault crypto to the service worker over a `vault_op`
  // message (the offscreen may lack chrome.storage). Simulate that SW handler so
  // the at-rest encryption property is still exercised through the real vault.
  vi.stubGlobal('chrome', {
    storage: { local: makeArea(), session: makeArea() },
    runtime: {
      async sendMessage(msg: { type: string; op: string; value?: string }) {
        if (msg?.type !== 'vault_op') return undefined;
        if (msg.op === 'state') return { state: await getVaultState() };
        if (msg.op === 'encrypt') return { value: await vaultEncrypt(msg.value ?? '') };
        return { value: await vaultDecrypt(msg.value ?? '') };
      },
    },
  });
});

describe('repo encryption at rest', () => {
  it('no vault: chunk text is stored in plaintext (unchanged behavior)', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['the secret plan'], [vec(8, 1)], { embedModel: 'local:m' });
    expect(await diskText('r', 'chunks.json')).toContain('the secret plan');
  });

  it('unlocked vault: chunk text + keyword index are ciphertext at rest, but search returns plaintext', async () => {
    await setupVault('correct horse battery staple');
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['the secret plan'], [vec(8, 1)], { embedModel: 'local:m' });

    const chunksOnDisk = await diskText('r', 'chunks.json');
    expect(chunksOnDisk).not.toContain('the secret plan');
    expect(chunksOnDisk).toContain('__enc');
    const kwOnDisk = await diskText('r', 'keywordIndex.json');
    expect(kwOnDisk).toContain('__enc');
    // meta.json (catalogue) stays plaintext so the repo list works while locked.
    expect(await diskText('r', 'meta.json')).toContain('"chunkCount"');

    const res = await repoSearch('r', vec(8, 1), 3, 'local:m');
    expect(res.results[0].text).toBe('the secret plan');
  });

  it('locked vault: repo reads and writes are refused', async () => {
    await setupVault('pw');
    const { docId } = await repoAdd('r', { name: 'a', url: 'file:///a' }, ['body'], [vec(8, 1)], { embedModel: 'local:m' });
    await lockVault();

    await expect(repoSearch('r', vec(8, 1), 3, 'local:m')).rejects.toThrow(/Unlock the encryption vault/);
    await expect(repoAdd('r', { name: 'b', url: 'file:///b' }, ['x'], [vec(8, 2)], { embedModel: 'local:m' })).rejects.toThrow(/Unlock the encryption vault/);
    // The doc-scoped readers (used by graph builds) share repoSearch's corpus
    // cache as of the caching fix in repoStore.ts -- confirm the vault gate
    // still runs before any cache lookup, same as before that change.
    await expect(repoDocChunks('r', docId)).rejects.toThrow(/Unlock the encryption vault/);
    await expect(repoDocVectors('r', docId)).rejects.toThrow(/Unlock the encryption vault/);

    await unlockVault('pw');
    const res = await repoSearch('r', vec(8, 1), 3, 'local:m');
    expect(res.results[0].text).toBe('body');
  });
});
