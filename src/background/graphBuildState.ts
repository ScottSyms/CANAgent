// In-memory, per-repo graph-build bookkeeping shared between serviceWorker.ts
// (the `notebook_graph_build`/`notebook_graph_stop` message handlers) and
// graphExtract.ts (`scheduleInstantGraphRefresh`'s fire-and-forget background
// Instant-tier build). Lifted out of serviceWorker.ts into its own module so
// graphExtract.ts can read/guard on `graphBuilding` without an import cycle
// (serviceWorker.ts already imports build functions FROM graphExtract.ts).
//
// Lost on service-worker eviction, same as before this was split out — a
// build resumes from its checkpointed graph on the next request either way.

import type { GraphBuildBackboneProgress, GraphBuildInstantProgress, GraphBuildProgress } from './graphExtract';

/** Repos with a graph build currently in flight. */
export const graphBuilding = new Map<string, AbortController>();

/**
 * Latest in-flight progress per repo, same lifetime as `graphBuilding` — the
 * build functions' `onProgress` callbacks write here so `notebook_graph_get`
 * can report live stage/doc progress to the UI's poll, instead of only
 * what's been checkpointed to graph.json so far.
 */
export const graphBuildProgress = new Map<string, GraphBuildBackboneProgress | GraphBuildProgress | GraphBuildInstantProgress>();
