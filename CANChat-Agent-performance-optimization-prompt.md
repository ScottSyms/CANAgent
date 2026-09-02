# CANChat-Agent Document Ingestion + Graph Performance Optimization

## Role

Act as a senior performance engineer and TypeScript/browser-extension architect working directly on:

**Repository:** `https://github.com/ssc-dsai/CANChat-Agent`

Your job is to improve the wall-clock speed of uploaded-document ingestion, chunk embedding, hybrid RAG indexing, and document-graph construction.

Do not limit yourself to micro-optimizations. You are explicitly authorized to replace whole blocks of code, introduce new internal APIs, move workloads between execution contexts, and refactor storage layouts where justified.

The desired end state is:

> Uploaded documents become searchable through hybrid retrieval as quickly as possible. Graph construction must not block RAG availability. Richer graph features should progressively enrich the repository after the core index is usable.

---

# Primary Objective

Reduce end-to-end latency for:

1. Uploaded document extraction.
2. Text chunking.
3. Embedding generation.
4. Vector persistence.
5. Lexical/BM25 indexing.
6. Instant/document graph creation.
7. Named-entity graph enrichment.
8. Full LLM-assisted graph extraction.

Optimize **real production wall-clock time**, not just isolated algorithmic benchmarks.

The system must preserve:

- Hybrid semantic + lexical retrieval.
- Existing citation/provenance behavior.
- Incremental repository updates.
- Repository embedder consistency.
- Browser-extension compatibility.
- OPFS durability.
- Existing vault/encryption behavior unless an explicitly better compatible design is implemented.
- Graceful cancellation/resume behavior.
- Offline/local embedding support.

---

# Important Architectural Principle

Separate **search readiness** from **graph enrichment**.

The desired processing model is:

```text
Uploaded documents
        |
        v
parallel document extraction
        |
        v
sentence/token-aware chunking
        |
        v
GLOBAL chunk queue across all documents
        |
        v
high-throughput embedding batches
        |
        +----------------------+
        |                      |
        v                      v
vector persistence       BM25 / lexical index
        |                      |
        +----------+-----------+
                   |
                   v
             SEARCHABLE NOW
                   |
                   v
embedding-derived Instant graph
(no new embedding or LLM inference)
                   |
                   v
optional background NER enrichment
                   |
                   v
optional relationship/community LLM enrichment
                   |
                   v
optional Full GraphRAG extraction
```

Do not make the user wait for NER or LLM graph extraction before the uploaded documents are usable for RAG.

---

# Current Hotspots to Investigate

Pay particular attention to these files:

```text
src/background/repoIngest.ts
src/background/llmProvider.ts
src/background/graphExtract.ts

src/offscreen/localEmbed.ts
src/offscreen/localNer.ts
src/offscreen/repoStore.ts
src/offscreen/offscreen.ts

src/shared/repoChunk.ts
src/shared/vectorSearch.ts
src/shared/chunkClusters.ts
src/shared/annIndex.ts
src/shared/docGraph.ts
src/shared/graphCommunities.ts
src/shared/keywordSearch.ts

scripts/convert-litert-embed-model/convert.py
scripts/graph-build-benchmark.ts
src/shared/graphBuildBenchmark.ts
```

Inspect related types, tests, message definitions, and callers before changing interfaces.

---

# Known Problems / Hypotheses

Treat the following as hypotheses to verify against the current repository implementation.

## 1. Repeated whole-corpus graph reads

The graph path appears to repeatedly load whole repository artifacts while processing individual documents.

In particular, inspect whether:

- `repoDocChunks(repo, docId)` reads/decrypts/parses all of `chunks.json`, enriches the whole corpus, and only then slices the requested document.
- `repoDocVectors(repo, docId)` reads all of `vectors.bin` before returning one document's range.
- Quick graph construction calls document reads serially.
- Instant graph construction repeatedly reloads the corpus per document.

If confirmed, eliminate this behavior.

Preferred first implementation:

- Introduce a **revision-keyed corpus cache** in `repoStore.ts`.
- Read/decrypt/parse chunks once per repository revision.
- Read vectors once per repository revision.
- Reuse enriched chunk metadata.
- Invalidate the cache on add/delete/import/re-index operations.

A graph build over D documents should not perform D whole-corpus reads.

If a better solution exists, implement it.

---

# 2. Embedding is incorrectly partitioned at document boundaries

Inspect `ingestFilesBatch()`.

The existing design may:

- extract documents concurrently;
- chunk each independently;
- call `embedChunks()` once per document;
- cause every document to create its own fixed LiteRT batch sequence.

This is wasteful because embedding rows are independent.

Replace this with:

```text
extract documents
    ->
chunk documents
    ->
flatten ALL chunks from all ready documents
    ->
embed as one bounded global stream
    ->
map resulting vectors back to documents
    ->
persist documents in batch
```

Document boundaries must NOT reset embedding batches.

Maintain mapping metadata such as:

```ts
interface PreparedDocument {
  inputIndex: number;
  chunks: string[];
  vectorStart: number;
  vectorEnd: number;
}
```

Use bounded super-batches if required for memory management, but allow the local embedding runtime to fill its inference batches densely across document boundaries.

---

# 3. Eliminate local embedding round trips

Currently local embedding may perform this flow:

```text
service worker
    -> offscreen embedding
    -> number[][] returned to service worker
    -> vectors sent back to offscreen repository store
    -> normalize
    -> quantize
    -> persist
```

If confirmed, replace this with a fused offscreen ingestion operation.

Preferred design:

```text
service worker
    -> offscreen ingest request containing chunks/doc metadata
    -> local embedding inside offscreen
    -> normalize/quantize inside offscreen
    -> repo persistence inside offscreen
    -> return small result metadata only
```

Possible API:

```ts
repoIngestLocalBatch(...)
```

or:

```ts
RepoRequest {
  op: 'ingestLocalBatch'
}
```

Do not serialize and structured-clone hundreds or thousands of `number[][]` vectors between Chrome contexts when the vectors originate and terminate in the offscreen context.

---

# 4. Replace nested JavaScript vector arrays where practical

Inspect `localEmbed.ts`.

The current embedder may convert LiteRT output using constructs equivalent to:

```ts
Array.from(typedArraySlice)
```

for every embedding.

Avoid unnecessary:

- `Float32Array -> number[]`
- `number[] -> normalized number[]`
- `number[] -> Int8Array`

conversions.

Prefer packed buffers:

```ts
Float32Array // rows packed contiguously
Int8Array    // persisted rows packed contiguously
```

Where feasible, expose:

```ts
{
  vectors: Float32Array,
  rows: number,
  dim: number
}
```

rather than:

```ts
number[][]
```

Use typed-array subviews to operate on each row.

---

# 5. Avoid redundant vector normalization

The current local MiniLM LiteRT conversion reportedly bakes mean pooling and L2 normalization into the model.

Verify this in:

```text
scripts/convert-litert-embed-model/convert.py
src/offscreen/localEmbed.ts
```

If local embeddings are guaranteed normalized, avoid normalizing them again before quantization.

Keep normalization for external embedding providers unless their contract explicitly guarantees equivalent normalization.

Do not weaken correctness merely to remove a small operation.

---

# 6. Increase embedding throughput

The current LiteRT model reportedly uses fixed:

```text
batch = 8
sequence length = 256
```

Benchmark alternative ingest models:

```text
batch 8
batch 16
batch 32
```

Do not simply increase the one global model batch size without considering query latency.

Preferred design if fixed-shape LiteRT models are required:

```text
model.query.int8.tflite
    batch = 1

model.ingest.int8.tflite
    batch = 16 or 32
```

Use the query model for one/few-query embeddings and the ingestion model for bulk indexing.

If LiteRT dynamic batch dimensions work reliably in the supported Chrome environment, benchmark that alternative.

Selection must be driven by benchmark results.

Record:

- total chunks/sec;
- tokenizer time;
- model inference time;
- CPU vs WebGPU;
- small-doc batch utilization;
- peak memory;
- UI responsiveness.

---

# 7. Improve chunk packing

Inspect:

```text
src/shared/repoChunk.ts
```

The current implementation reportedly uses character-based chunks around:

```text
800 characters
120 character overlap
```

This may under-utilize a 256-token embedding input and repeatedly embed overlapping text.

Replace or augment this with a sentence-aware/token-budget packer.

Target behavior:

1. Segment text into sentences or natural blocks.
2. Pack sentences until approaching a target token/wordpiece budget.
3. Avoid exceeding the embedding model's input limit.
4. Preserve useful context overlap using approximately one preceding sentence or a small token overlap.
5. Avoid embedding large duplicated character spans.
6. Preserve deterministic chunk IDs/provenance.

Initial benchmark targets may include approximately:

```text
180-220 wordpieces usable content
20-30 token overlap
```

Do not assume these values are optimal.

Measure retrieval quality before permanently changing defaults.

Avoid adding expensive "semantic chunking" that requires another embedding pass unless benchmarks show a net win.

---

# 8. Make the Instant graph the immediate graph layer

The repository already contains an embedding-derived Instant graph path.

Inspect:

```text
buildRepoGraphInstant()
buildSimilarityEdges()
buildAnnIndex()
labelPropagate()
deriveClusterLabel()
```

The Instant graph should reuse chunk embeddings that were already computed for RAG.

It should require:

- no NER inference;
- no duplicate embedding;
- no LLM inference.

Make this cheap graph available immediately after indexing.

Expected conceptual graph:

```text
Document --contains--> Chunk
Chunk --next--> Chunk
Chunk --similar--> Chunk
Chunk --belongs_to--> Topic
Topic --related--> Topic
```

Named entities and richer relationships should be enrichment layers, not prerequisites for the first graph.

---

# 9. Redesign Quick NER throughput

Inspect:

```text
src/offscreen/localNer.ts
src/background/graphExtract.ts
```

The existing NER implementation reportedly:

- uses single-threaded WASM;
- deliberately sets `NER_BATCH = 1`;
- does so because larger inference calls caused Chrome UI freezes;
- processes documents sequentially in the Quick graph path.

Do not simply increase `NER_BATCH` on the existing main offscreen execution context.

Instead investigate moving NER inference to a **dedicated Web Worker** owned by the offscreen document.

Target design:

```text
offscreen document
       |
       v
NER worker
       |
       +-- tokenizer
       +-- WASM/WebGPU inference
       +-- BIO aggregation
```

Then benchmark:

```text
batch 1
batch 4
batch 8
batch 16
```

Also test Transformers.js WebGPU if supported by the model/operator set.

Preferred behavior:

- UI remains responsive.
- NER throughput is substantially higher.
- cancellation remains possible at batch boundaries.
- worker/model lifecycle is cached rather than reconstructed per document.

If WebGPU is unreliable, retain a Worker-based WASM fallback.

---

# 10. Remove per-document graph serialization where possible

Inspect Quick graph checkpointing.

If the current flow performs approximately:

```text
process one document
   ->
serialize graph
   ->
encrypt graph
   ->
write graph.json
   ->
process next document
```

replace it with less frequent checkpointing.

Potential strategy:

- checkpoint every N documents;
- checkpoint every M seconds;
- checkpoint on explicit stop/cancel;
- checkpoint before long enrichment phases;
- checkpoint after dedup;
- checkpoint at final completion.

Preserve resumability.

A stronger design is an append-only graph delta journal plus occasional compact snapshots, but only introduce that complexity if justified.

---

# 11. Replace fixed concurrency waves with rolling pools

Inspect concurrency helpers in:

```text
graphExtract.ts
repoIngest.ts
```

If code does:

```ts
for (...) {
  const batch = ...
  await Promise.all(batch.map(...))
}
```

then one slow request holds the next wave behind it.

Use a shared rolling concurrency pool where appropriate.

Example interface:

```ts
runWithConcurrency(items, concurrency, async item => {
  ...
});
```

Move the reusable helper into something like:

```text
src/shared/asyncPool.ts
```

Use it for:

- Full graph extraction.
- Relation typing.
- Community summaries.
- Other variable-latency independent work.

Do not exceed endpoint rate limits.

Make concurrency configurable if useful.

---

# 12. Improve repository storage scaling

Inspect `repoStore.ts`.

The repository reportedly stores:

```text
chunks.json
keywordIndex.json
vectors.bin
meta.json
graph.json
```

and rewrites the complete chunk/index JSON payload on updates.

Measure the impact at growing corpus sizes.

At minimum consider:

```text
docs/<docId>.json
```

or other document/chunk sharding so adding one document does not require rewriting all chunk text.

Possible designs:

### Option A — sharded encrypted OPFS

```text
repos/<repo>/
    meta.json
    vectors.bin
    keyword/
    docs/
        <doc-id>.json
        <doc-id>.json
        ...
```

Advantages:

- works naturally with existing OPFS;
- keeps encryption at document/file granularity;
- avoids full `chunks.json` rewrites.

### Option B — OPFS-backed SQLite WASM

Use SQLite/FTS for:

- document metadata;
- chunks;
- sentence metadata;
- BM25/FTS retrieval.

Keep packed vectors separately if that remains faster.

Only adopt this if:

- browser-extension support is robust;
- build complexity is acceptable;
- vault/encryption requirements can be preserved.

Do not casually trade away encryption semantics.

---

# 13. Correct the graph performance benchmark

The current graph benchmark may time only:

- synthetic entity merges;
- embedding dedup over synthetic vectors;
- community detection;
- projected LLM latency.

That misses the expensive production stages.

Create a production-representative benchmark.

The benchmark must separately report:

```text
document extraction
chunking
tokenization
embedding model initialization
embedding inference
Chrome/offscreen transport
vector quantization
repository writes
keyword/BM25 indexing
repo corpus reads
NER initialization
NER inference
graph merge
entity embedding dedup
community detection
graph serialization/encryption
LLM enrichment
TOTAL
```

At least provide:

```text
cold run
warm run
```

Test representative corpora such as:

```text
100 tiny documents
20 medium documents
1 very large document
mixed corpus
```

Track:

```text
documents/sec
chunks/sec
embeddings/sec
NER windows/sec
total ingest seconds
time-to-searchable
time-to-Instant-graph
time-to-Quick-graph
peak memory
UI long-task behavior
```

Do not accept a benchmark that begins after embedding/NER work has already been performed.

---

# Ordered Implementation Plan

Implement in roughly this order unless repository realities justify changing it.

## Phase 1 — Instrument the real pipeline

Before large changes, add timing instrumentation around major phases.

Create structured timing output, ideally using:

```ts
performance.now()
```

Produce an easy-to-read report.

Do not optimize blind.

---

## Phase 2 — Fix repeated corpus reads

Implement one of:

1. revision-keyed whole-corpus cache; or
2. one-shot bulk graph data fetch.

Preferred short-term solution:

```text
getCorpusData(repo)
```

which returns:

```ts
{
  revision,
  meta,
  chunks,
  vectors
}
```

Graph code must not repeatedly decrypt/read the entire corpus once per document.

---

## Phase 3 — Global embedding batching

Refactor multi-file ingestion so chunk embedding crosses document boundaries.

Acceptance test:

- 100 one-chunk documents should not trigger 100 mostly-padded fixed batches.
- embedding batch utilization should be close to full except for the final batch.

---

## Phase 4 — Fused local ingest

Introduce an offscreen operation that performs:

```text
embedding
    ->
quantization
    ->
storage
```

without sending bulk float vectors through the service worker.

Prefer typed arrays internally.

---

## Phase 5 — Dual embedding runtime

Benchmark and implement separate bulk-ingest and query models if justified.

Example:

```text
query: batch 1
ingest: batch 32
```

Do not regress query latency.

---

## Phase 6 — Better chunk packing

Introduce sentence/token-budget chunking.

Run retrieval benchmarks before changing defaults.

---

## Phase 7 — Instant graph on ingest

Make the embedding-derived graph cheap and immediate.

Do not rerun embedding.

---

## Phase 8 — NER worker

Move NER inference off the offscreen main thread.

Increase throughput without reintroducing Chrome "Page Unresponsive" failures.

---

## Phase 9 — Reduce graph checkpoint writes

Batch graph persistence while preserving resumability.

---

## Phase 10 — Storage redesign if still necessary

If profiling shows JSON rewrite/encryption remains a dominant cost, implement sharded document storage or an alternative OPFS data engine.

---

# Correctness Constraints

Do not introduce changes that silently break retrieval correctness.

Preserve or explicitly migrate:

- document IDs;
- chunk IDs;
- sentence IDs;
- source URLs;
- citation spans;
- repository revision semantics;
- graph corpus revision checks;
- embedder identity locks;
- incremental folder sync metadata;
- deletion behavior;
- imports/exports;
- encryption/vault behavior.

If storage format changes, provide a migration path or version gate.

---

# Performance Engineering Rules

1. Measure before and after.
2. Report wall-clock time, not just Big-O.
3. Avoid unnecessary object allocation in hot loops.
4. Prefer typed arrays for numeric data.
5. Avoid cross-context copying of huge vector arrays.
6. Reuse initialized models and tokenizers.
7. Keep GPU/CPU work busy with dense batches.
8. Do not let document boundaries artificially fragment compute batches.
9. Do not repeatedly parse/decrypt the same corpus revision.
10. Do not block search readiness on graph enrichment.
11. Preserve browser UI responsiveness.
12. Avoid unbounded concurrency.
13. Prefer streaming/bounded-memory algorithms.
14. Add tests for changed behavior.
15. Do not remove existing fallback behavior without replacing it.

---

# Tests to Add or Update

At minimum add tests for:

### Global embedding batching

Verify multiple documents can be flattened and correctly reassembled after embedding.

Test:

```text
doc A: 3 chunks
doc B: 7 chunks
doc C: 1 chunk
```

Ensure vectors map back to the correct documents.

---

### Corpus caching

Verify:

- repeated document reads use the same revision cache;
- adding/deleting a document invalidates it;
- graph builders receive correct slices.

---

### Typed vector packing

Verify packed vectors preserve row order and dimensions.

---

### Chunk packing

Verify:

- deterministic output;
- no accidental text loss;
- overlap behavior;
- stable provenance;
- maximum model token budget.

---

### Cancellation

Verify cancellation at:

- extraction;
- embedding batch;
- NER batch;
- LLM extraction;
- persistence checkpoints.

---

### Repository revision safety

Graph updates must still fail safely if the corpus changes during a graph build.

---

### Search readiness

Verify documents can be queried before NER/Full graph enrichment finishes.

---

# Benchmark Acceptance Criteria

Do not invent numbers before measuring.

After implementation, produce a benchmark table comparing baseline vs optimized behavior.

Example:

| Scenario | Metric | Baseline | Optimized | Change |
|---|---:|---:|---:|---:|
| 100 tiny docs | time to searchable | | | |
| 100 tiny docs | embedding batches | | | |
| 20 medium docs | chunks/sec | | | |
| 1 large PDF | time to searchable | | | |
| mixed corpus | Instant graph time | | | |
| mixed corpus | Quick graph time | | | |
| mixed corpus | full graph time | | | |
| mixed corpus | peak memory | | | |

Also report where remaining time is spent after optimization.

---

# Expected Deliverables

Work directly against the repository.

Deliver:

1. **Baseline analysis**
   - actual production-path bottlenecks;
   - measured timings;
   - confirmation or rejection of the hypotheses above.

2. **Implementation**
   - code changes;
   - new helpers/workers/interfaces as needed;
   - migration code if persistence changes.

3. **Tests**
   - unit tests;
   - integration tests;
   - performance tests where practical.

4. **Benchmark results**
   - before/after numbers;
   - cold/warm results;
   - batch utilization;
   - time-to-searchable;
   - graph timings.

5. **Architecture summary**
   - brief description of the new ingestion pipeline;
   - major tradeoffs;
   - anything intentionally left for a future pass.

6. **Changed-file summary**
   - file;
   - what changed;
   - why.

---

# Working Style

Do not stop after analyzing the repository.

Proceed to implementation.

Do not ask for permission for straightforward refactors that are necessary to achieve the stated objective.

If one hypothesis proves wrong, document that and move to the next bottleneck.

Prefer a small number of high-impact architectural changes over dozens of tiny speculative tweaks.

Do not optimize code that profiling shows is insignificant.

Keep the repository building and tests passing after each major phase.

Where an aggressive refactor is risky, implement the lower-risk high-value optimization first, benchmark it, then continue if the bottleneck remains.

---

# Definition of Done

The task is complete when:

1. Multi-document uploads no longer waste embedding batches at document boundaries.
2. Graph builders no longer repeatedly load/decrypt the full corpus once per document.
3. Local embeddings are not unnecessarily copied service-worker → offscreen → service-worker → offscreen.
4. Search becomes available independently of graph enrichment.
5. Instant graph generation reuses existing RAG embeddings.
6. Quick graph NER no longer relies on deliberately low-throughput main-thread batch-1 inference if a worker-based solution performs better.
7. Graph persistence no longer performs excessive whole-graph checkpoints.
8. Benchmarks measure the real production path.
9. Before/after results demonstrate a material reduction in time-to-searchable and graph-build wall-clock time.
10. Existing retrieval/citation correctness remains intact.
