## Specification Amendment: Sentence-Level Evidence and Citation

### Objective

Add sentence-level provenance to the knowledge ingestion and retrieval pipeline so that CANChat Agent can provide precise, reproducible citations to the exact sentence or sentences supporting an answer, while continuing to use larger semantic chunks for vector retrieval.

The design principle is:

**Chunks for retrieval. Sentences for evidence. Source coordinates for navigation.**

### 1. Document ingestion

When a document is ingested:

1. Extract the source text while preserving available source metadata such as:

   * document ID
   * page number
   * section/heading
   * paragraph
   * source URL or file reference
   * PDF bounding-box coordinates, where available

2. Divide the document into semantic chunks suitable for embedding and retrieval.

3. Within every chunk, identify sentence boundaries.

4. Assign every sentence a stable identifier that persists for the lifetime of the indexed document.

A sentence ID should preferably be globally unique within the document rather than merely numbered within a chunk.

Example:

```text
doc-73:chunk-42:s1
doc-73:chunk-42:s2
doc-73:chunk-42:s3
```

### 2. Sentence metadata

For each sentence, store metadata similar to:

```json
{
  "sentence_id": "doc-73:chunk-42:s3",
  "chunk_id": "doc-73:chunk-42",
  "start_offset": 184,
  "end_offset": 276,
  "page": 7,
  "paragraph": 3
}
```

The canonical source text does not need to be duplicated if the sentence can be reconstructed from the chunk using its character offsets.

Where source formats expose coordinates, optionally store:

```json
{
  "bounding_box": {
    "x": 0.14,
    "y": 0.36,
    "width": 0.72,
    "height": 0.04
  }
}
```

This allows the application eventually to highlight the original sentence directly within a rendered PDF or document.

### 3. Embedding strategy

Do **not** require sentence-level embeddings.

Vector embeddings should normally continue to operate on semantic chunks containing enough surrounding context to produce useful retrieval.

For example:

```text
Document
   ↓
Paragraphs / sections
   ↓
Semantic chunks ───────────→ embedding/vector index
   ↓
Sentence boundaries
   ↓
Sentence IDs + offsets ────→ provenance index
```

This separates two different concerns:

* **Semantic chunks:** locate relevant information.
* **Sentences:** identify the precise evidence supporting a claim.

### 4. Retrieval

When answering a query:

1. Embed the user query.
2. Retrieve the highest-ranking chunks from the vector index.
3. Retrieve the sentence metadata associated with those chunks.
4. Present the retrieved text to the LLM with explicit sentence identifiers.

For example:

```text
[doc73-c42-s1] Shared Services Canada provides common IT services to federal departments.

[doc73-c42-s2] The department operates several enterprise cloud services.

[doc73-c42-s3] Generative AI workloads are currently distributed across commercial and internally hosted models.

[doc73-c42-s4] Model selection is generally configured at the application level.
```

The sentence identifiers are retrieval metadata and should not modify the stored source text.

### 5. Model response contract

The model must not generate citations as free-form quotations.

Instead, require structured evidence references to sentence IDs supplied in its context.

Example response contract:

```json
{
  "answer": "Model selection is currently performed primarily at the application level.",
  "evidence": [
    "doc73-c42-s4"
  ]
}
```

For answers containing several claims:

```json
{
  "claims": [
    {
      "text": "SSC operates several enterprise cloud services.",
      "evidence": ["doc73-c42-s2"]
    },
    {
      "text": "Generative AI workloads use both commercial and internally hosted models.",
      "evidence": ["doc73-c42-s3"]
    }
  ]
}
```

The model may only cite sentence IDs that were supplied in the current retrieval context.

### 6. Citation validation

Before displaying the answer, the application must validate citations programmatically.

For every returned sentence ID:

* verify that the ID exists;
* verify that it was present in the retrieved context supplied to the model;
* reject or remove fabricated IDs;
* resolve the ID to the underlying source document and offsets.

Citation validity should therefore be deterministic even though the model's selection of evidence is probabilistic.

### 7. User interface behaviour

A displayed citation should resolve through:

```text
answer
  → sentence_id
  → chunk_id
  → document_id
  → source location
```

Selecting a citation should allow the interface to:

* display the exact supporting sentence;
* show surrounding paragraph/chunk context;
* identify the original document;
* navigate to the appropriate page;
* highlight the exact sentence;
* optionally show adjacent sentences.

Highlighting should be based on stored offsets or document coordinates rather than fuzzy string matching.

### 8. Evidence-first answer generation

Where practical, require the model to identify evidence before composing the final response.

Conceptually:

```text
Question
   ↓
Chunk retrieval
   ↓
Select supporting sentence IDs
   ↓
Generate claims from selected evidence
   ↓
Validate citation IDs
   ↓
Render answer + citations
```

This is preferable to generating an answer first and attempting to discover supporting citations afterward.

### 9. Knowledge graph integration

Sentence IDs should form the common provenance mechanism for the wider knowledge system.

Knowledge graph nodes and relationships should contain evidence references.

Example:

```json
{
  "subject": "CANChat",
  "predicate": "uses",
  "object": "Azure OpenAI",
  "evidence": [
    "doc73-c42-s3"
  ]
}
```

A graph relationship can therefore always be traced back to the source sentence from which it was derived.

The same evidence mechanism can support:

* RAG citations;
* knowledge graph provenance;
* extracted facts;
* timelines;
* entity relationships;
* summaries;
* generated reports;
* agent decisions.

### 10. OPFS storage model

A browser-native implementation may maintain separate logical stores in OPFS:

```text
/notebooks/
    notebook-id/
        documents/
        chunks/
        sentences/
        embeddings/
        graph/
        metadata/
```

Conceptually:

```text
documents
    document_id
    metadata
    source

chunks
    chunk_id
    document_id
    text
    embedding

sentences
    sentence_id
    chunk_id
    start_offset
    end_offset
    page
    coordinates

graph_nodes
    node_id
    type
    properties

graph_edges
    edge_id
    subject
    predicate
    object
    evidence_sentence_ids
```

DuckDB-WASM or another browser-local structured store can provide the logical indexing while OPFS provides persistent storage.

### 11. Stability requirements

Sentence identifiers must remain stable unless the underlying document is re-ingested or materially changed.

Avoid creating IDs solely from the ordinal retrieval order.

Where useful, combine structural identity with a source-text hash so that unchanged sentences can be recognized between ingestion runs.

For example:

```text
doc73:p7:para3:s2:8f31ca
```

### 12. Design constraints

The implementation should:

* retain relatively large chunks for semantic retrieval;
* avoid creating an embedding for every sentence unless empirical testing shows a benefit;
* maintain deterministic mappings from citation IDs to source text;
* avoid fuzzy matching during citation rendering;
* retain source provenance throughout ingestion and transformation;
* allow citation metadata to be reused by RAG, graph extraction, summarization and agent workflows;
* support entirely browser-local storage using OPFS where appropriate.

### Acceptance criterion

Given a retrieved chunk containing multiple sentences, CANChat Agent must be able to generate an answer citing one or more stable sentence IDs and, when the user selects a citation, deterministically display and highlight the exact sentence in the originating document without performing another semantic search or LLM call.

