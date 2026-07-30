import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCheckpoint, readCheckpoint, writeCheckpoint, type InFlightCheckpoint } from './checkpoint';

// Minimal chrome.storage.local fake (get by string key, set, remove).
function installFakeStorage() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(key: string | string[]) {
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
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
  return store;
}

const sample: InFlightCheckpoint = {
  conversationId: 'conv-1',
  epoch: 4,
  stepsUsed: 7,
  stepBudget: 20,
  plan: [{ text: 'do thing', status: 'in_progress' }],
  findings: ['found A'],
  lastUserText: 'research X',
  unattended: false,
  updatedAt: new Date().toISOString(),
};

describe('in-flight checkpoint', () => {
  beforeEach(() => {
    installFakeStorage();
  });

  it('round-trips write → read, preserving step/plan/findings', async () => {
    await writeCheckpoint(sample);
    const back = await readCheckpoint();
    expect(back?.stepsUsed).toBe(7);
    expect(back?.plan?.[0].text).toBe('do thing');
    expect(back?.findings).toEqual(['found A']);
    expect(back?.conversationId).toBe('conv-1');
  });

  it('returns null when nothing is checkpointed', async () => {
    expect(await readCheckpoint()).toBeNull();
  });

  it('clears the checkpoint (so an interruption is only recovered once)', async () => {
    await writeCheckpoint(sample);
    await clearCheckpoint();
    expect(await readCheckpoint()).toBeNull();
  });
});
