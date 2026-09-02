import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, runWithConcurrency } from './asyncPool';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('returns results index-aligned regardless of completion order', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const items = [0, 1, 2];
    const resultPromise = mapWithConcurrency(items, 3, async (i) => {
      await gates[i].promise;
      return `r${i}`;
    });
    // Resolve out of order: item 2 finishes first, then 0, then 1.
    gates[2].resolve();
    await Promise.resolve();
    gates[0].resolve();
    await Promise.resolve();
    gates[1].resolve();
    const results = await resultPromise;
    expect(results).toEqual(['r0', 'r1', 'r2']);
  });

  it('respects the concurrency limit: at most `limit` calls are in flight at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('handles limit greater than items.length without hanging or over-allocating workers', async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (i) => i * 2);
    expect(results).toEqual([2, 4]);
  });

  it('handles limit <= 0 by running with at least one worker instead of hanging', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (i) => i);
    expect(results).toEqual([1, 2, 3]);
  });

  it('returns [] for empty input without calling fn', async () => {
    let called = false;
    const results = await mapWithConcurrency<number, number>([], 4, async (i) => {
      called = true;
      return i;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('propagates a single rejection (matches the pre-consolidation Promise.all-based behavior at every replaced call site)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
  });

  it('passes the item index to fn', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(['a', 'b', 'c'], 2, async (_item, index) => {
      seen.push(index);
    });
    expect(seen.sort()).toEqual([0, 1, 2]);
  });
});

describe('runWithConcurrency', () => {
  it('runs fn for every item with side-effecting writes into an outer array', async () => {
    const out = new Array<number>(5);
    await runWithConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
      out[i] = i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });
});
