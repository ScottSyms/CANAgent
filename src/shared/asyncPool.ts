// Shared rolling-pool concurrency helper. Before this file existed, three
// independent (and functionally near-identical) implementations lived in
// src/background/repoIngest.ts, src/background/jobEngine.ts, and a private
// method in src/background/agentRuntime.ts — this consolidates them into one.
//
// "Rolling pool" means each of `limit` workers pulls the next unclaimed item
// as soon as it finishes its current one, rather than waiting for a whole
// fixed-size batch to settle before starting the next (which idles freed
// slots behind whichever item in the batch is slowest). Contrast with
// src/background/graphExtract.ts's `mapInBatches`, a deliberately different,
// fixed-batch helper used where a batch boundary IS the checkpoint unit —
// see mapInBatches's own doc comment for why that one is NOT replaced by this.

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Results are
 * returned index-aligned with `items`, regardless of completion order. A
 * single rejection propagates (via `Promise.all` over the worker loops) and
 * rejects the whole call — callers that need per-item error isolation should
 * make `fn` itself catch and return a result/error union, not let it throw.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Same rolling pool as `mapWithConcurrency`, for side-effecting callers that
 * write their own results (e.g. into an outer array by index from within
 * `fn`) instead of returning a value to collect.
 */
export async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  await mapWithConcurrency(items, limit, fn);
}
