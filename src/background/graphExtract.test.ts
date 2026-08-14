import { afterEach, describe, expect, it, vi } from 'vitest';

// complete() is the only model touchpoint; mock it so extraction is deterministic.
const complete = vi.fn();
const resolveModelForRole = vi.fn((settings: unknown, _role: unknown) => settings);
// Default: a one-hot vector keyed by exact input text, so identical text maps
// to the same vector (cosine 1) but any two different texts are exactly
// orthogonal (cosine 0) — no accidental merges across the wider test suite.
// Tests that specifically exercise dedup provide their own mock.
const embedTextIndex = new Map<string, number>();
const EMBED_DIM = 64;
function hashEmbed(text: string): number[] {
  let idx = embedTextIndex.get(text);
  if (idx === undefined) {
    idx = embedTextIndex.size;
    embedTextIndex.set(text, idx);
  }
  const v = new Array(EMBED_DIM).fill(0);
  v[idx % EMBED_DIM] = 1;
  return v;
}
const embedChunks = vi.fn(async (_settings: unknown, texts: string[], _signal?: AbortSignal) => texts.map(hashEmbed));
const embedderId = vi.fn((_settings: unknown) => 'local:test-embed-model');
// vi.mock's factory is hoisted above all other top-level code, so a plain
// `class` declaration referenced inside it would hit the temporal dead zone —
// vi.hoisted() hoists this alongside the mock factory itself.
const { MockLlmError } = vi.hoisted(() => {
  class MockLlmError extends Error {
    readonly retryable: boolean;
    readonly content?: string | null;
    constructor(message: string, options?: { retryable?: boolean; content?: string | null }) {
      super(message);
      this.name = 'LlmError';
      this.retryable = options?.retryable ?? false;
      this.content = options?.content;
    }
  }
  return { MockLlmError };
});
vi.mock('./llmProvider', () => ({
  complete: (...a: unknown[]) => complete(...a),
  resolveModelForRole: (settings: unknown, role: unknown) => resolveModelForRole(settings, role),
  embedChunks: (settings: unknown, texts: string[], signal?: AbortSignal) => embedChunks(settings, texts, signal),
  embedderId: (settings: unknown) => embedderId(settings),
  LlmError: MockLlmError,
}));
const graphSnapshot = vi.fn();
const graphGetRaw = vi.fn();
const graphSet = vi.fn();
const docChunks = vi.fn();
const docVectors = vi.fn();
// Default: no entities found. Fast-tier tests that care about extraction
// content provide their own implementation.
const nerLocal = vi.fn(
  async (texts: string[], _model?: string, _signal?: AbortSignal): Promise<NerLocalResponse> => ({
    ok: true,
    spans: texts.map(() => []),
    model: 'test-ner-model',
  }),
);
vi.mock('./offscreenClient', () => ({
  graphSnapshot: (...a: unknown[]) => graphSnapshot(...a),
  graphGetRaw: (...a: unknown[]) => graphGetRaw(...a),
  graphSet: (...a: unknown[]) => graphSet(...a),
  docChunks: (...a: unknown[]) => docChunks(...a),
  docVectors: (...a: unknown[]) => docVectors(...a),
  nerLocal: (texts: string[], model?: string, signal?: AbortSignal) => nerLocal(texts, model, signal),
}));
const resolveSentenceCitations = vi.fn(async (_repo: string, ids: string[]) => ids.map((id) => ({ sentenceId: id, docName: 'doc', url: '', sentenceText: `Sentence text for ${id}.`, chunkText: '', start: 0, end: 0 })));
vi.mock('./sentenceResolve', () => ({
  resolveSentenceCitations: (repo: string, ids: string[]) => resolveSentenceCitations(repo, ids),
}));

import {
  buildRepoGraph,
  buildRepoGraphInstant,
  buildRepoGraphQuick,
  buildSentenceContextWindows,
  dedupeEntitiesByEmbedding,
  enrichRelationTypes,
  evenlySpacedIndices,
  extractOneDoc,
  extractWindowAdaptive,
  getDocWindows,
  looksTruncated,
  scoreWindowInformationValue,
  splitTaggedWindow,
  summarizeCommunities,
  summarizeCommunitiesIncremental,
  tagDocChunks,
  windowDocChunks,
  windowDocChunksForNer,
} from './graphExtract';
import { LlmError } from './llmProvider';
import { emptyDocGraph, mergeExtraction } from '../shared/docGraph';
import { detectCommunities, extractiveCommunitySummary } from '../shared/graphCommunities';
import { COMMUNITY_SUMMARY_SCHEMA, DOC_EXTRACTION_SCHEMA, RELATION_TYPING_SCHEMA } from '../shared/graphJsonSchemas';
import type { NerLocalResponse } from '../shared/messages';
import { shortHash } from '../shared/sentenceSplit';
import type { Settings } from '../shared/types';
import { normalizeVector, quantizeVector } from '../shared/vectorSearch';

afterEach(() => {
  complete.mockReset();
  resolveModelForRole.mockClear();
  embedChunks.mockClear();
  embedderId.mockClear();
  embedTextIndex.clear();
  nerLocal.mockClear();
  graphSnapshot.mockReset();
  graphGetRaw.mockReset();
  graphSet.mockReset();
  docChunks.mockReset();
  docVectors.mockReset();
  resolveSentenceCitations.mockClear();
});

// graphGleaningEnabled defaults to true in the app (see graphExtract.ts), but
// most tests here aren't testing gleaning and would otherwise need to account
// for its extra complete() call on every successful window -- explicitly off
// in the shared fixture; the dedicated gleaning tests opt back in.
const S = { graphGleaningEnabled: false } as Settings;

describe('tagDocChunks', () => {
  it('tags each sentence with its id and collects the valid-id allow-list', () => {
    const { text, validIds } = tagDocChunks([
      {
        text: 'First fact here. Second fact follows.',
        sentences: [
          { id: 'd:c0:s0#a', start: 0, end: 16 },
          { id: 'd:c0:s1#b', start: 17, end: 37 },
        ],
      },
    ]);
    expect(text).toBe('[[d:c0:s0#a]] First fact here.\n[[d:c0:s1#b]] Second fact follows.');
    expect([...validIds]).toEqual(['d:c0:s0#a', 'd:c0:s1#b']);
  });

  it('stops at the char budget', () => {
    const { validIds } = tagDocChunks(
      [{ text: 'aaaa. bbbb.', sentences: [{ id: 'i0', start: 0, end: 5 }, { id: 'i1', start: 6, end: 11 }] }],
      15, // only room for the first tagged line
    );
    expect([...validIds]).toEqual(['i0']);
  });
});

describe('windowDocChunks', () => {
  it('covers the whole document across multiple windows when it exceeds one budget', () => {
    const sentences = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, start: i * 6, end: i * 6 + 5 }));
    const text = sentences.map((_, i) => `word${i} `).join('');
    const windows = windowDocChunks([{ text, sentences }], 20); // small budget forces multiple windows
    expect(windows.length).toBeGreaterThan(1);
    const allIds = windows.flatMap((w) => [...w.validIds]);
    expect(new Set(allIds)).toEqual(new Set(sentences.map((s) => s.id))); // every sentence covered exactly once
    for (const w of windows) expect(new Set(w.validIds).size).toBe([...w.validIds].length); // no duplicates within a window
  });

  it('caps at maxWindows while sampling through the end of the document', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, start: 0, end: 5 }));
    const text = 'x'.repeat(50);
    const windows = windowDocChunks(
      sentences.map((s) => ({ text, sentences: [s] })),
      1, // each sentence alone exceeds this budget, forcing a new window every time
      3,
    );
    expect(windows).toHaveLength(3);
    expect([...windows[0].validIds]).toEqual(['s0']);
    expect([...windows.at(-1)!.validIds]).toEqual(['s9']);
  });

  it('returns a single empty window for no input', () => {
    expect(windowDocChunks([])).toEqual([{ text: '', validIds: new Set() }]);
  });
});

describe('windowDocChunksForNer', () => {
  it('produces raw untagged text with sentence offsets that reconstruct each sentence exactly', () => {
    const chunks = [
      {
        text: 'First fact here. Second fact follows.',
        sentences: [
          { id: 'd:c0:s0#a', start: 0, end: 16 },
          { id: 'd:c0:s1#b', start: 17, end: 38 },
        ],
      },
    ];
    const [window] = windowDocChunksForNer(chunks);
    expect(window.text).not.toContain('[[');
    expect(window.text).toBe('First fact here. Second fact follows.');
    for (const s of window.sentences) {
      const expected = s.id === 'd:c0:s0#a' ? 'First fact here.' : 'Second fact follows.';
      expect(window.text.slice(s.start, s.end)).toBe(expected);
    }
  });

  it('splits into multiple windows under a small budget, covering every sentence exactly once when under the window cap', () => {
    const sentences = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, start: i * 6, end: i * 6 + 5 }));
    const text = sentences.map((_, i) => `word${i} `).join('');
    const windows = windowDocChunksForNer([{ text, sentences }], 12);
    expect(windows.length).toBeGreaterThan(1);
    const allIds = windows.flatMap((w) => w.sentences.map((s) => s.id));
    expect(new Set(allIds)).toEqual(new Set(sentences.map((s) => s.id)));
    expect(allIds).toHaveLength(6);
  });

  it('samples down to maxWindows on a document that would otherwise need far more, instead of covering it unconditionally', () => {
    // 100 one-sentence-per-window windows at this tiny budget; capped at 10.
    const sentences = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, start: i * 6, end: i * 6 + 5 }));
    const text = sentences.map((_, i) => `word${i} `).join('');
    const windows = windowDocChunksForNer([{ text, sentences }], 6, 10);
    expect(windows).toHaveLength(10);
  });

  it('returns a single empty window for no input', () => {
    expect(windowDocChunksForNer([])).toEqual([{ text: '', sentences: [] }]);
  });
});

describe('buildSentenceContextWindows', () => {
  const threeSentences = [
    {
      text: 'Brian reviewed the pipeline. He said PDF extraction was unreliable. Josh agreed to investigate.',
      sentences: [
        { id: 's0', start: 0, end: 28 },
        { id: 's1', start: 29, end: 68 },
        { id: 's2', start: 68, end: 96 },
      ],
    },
  ];

  it('produces one window per sentence, with CONTEXT BEFORE/TARGET/CONTEXT AFTER sections', () => {
    const windows = buildSentenceContextWindows(threeSentences);
    expect(windows).toHaveLength(3);

    // First sentence: no preceding context.
    expect(windows[0].text).not.toContain('CONTEXT BEFORE:');
    expect(windows[0].text).toContain('TARGET:\n[[s0]] Brian reviewed the pipeline.');
    expect(windows[0].text).toContain('CONTEXT AFTER:\n[[s1]]');

    // Middle sentence: both sides present.
    expect(windows[1].text).toContain('CONTEXT BEFORE:\n[[s0]]');
    expect(windows[1].text).toContain('TARGET:\n[[s1]] He said PDF extraction was unreliable.');
    expect(windows[1].text).toContain('CONTEXT AFTER:\n[[s2]]');

    // Last sentence: no following context.
    expect(windows[2].text).toContain('CONTEXT BEFORE:\n[[s1]]');
    expect(windows[2].text).toContain('TARGET:\n[[s2]] Josh agreed to investigate.');
    expect(windows[2].text).not.toContain('CONTEXT AFTER:');
  });

  it('restricts validIds to the target sentence only, even though context sentence ids appear in the text', () => {
    const windows = buildSentenceContextWindows(threeSentences);
    expect([...windows[1].validIds]).toEqual(['s1']);
    expect(windows[1].text).toContain('[[s0]]'); // context id appears in text...
    expect(windows[1].validIds.has('s0')).toBe(false); // ...but isn't a valid evidence id
  });

  it('respects a wider contextBefore/contextAfter', () => {
    const fiveSentences = [
      {
        text: 'One. Two. Three. Four. Five.',
        sentences: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, start: i * 5, end: i * 5 + 4 })),
      },
    ];
    const windows = buildSentenceContextWindows(fiveSentences, { contextBefore: 2, contextAfter: 2 });
    // Middle sentence (index 2) should see both neighbors on each side.
    expect(windows[2].text).toContain('[[s0]]');
    expect(windows[2].text).toContain('[[s1]]');
    expect(windows[2].text).toContain('[[s3]]');
    expect(windows[2].text).toContain('[[s4]]');
  });

  it('supports zero context on either side', () => {
    const windows = buildSentenceContextWindows(threeSentences, { contextBefore: 0, contextAfter: 0 });
    expect(windows[1].text).not.toContain('CONTEXT BEFORE:');
    expect(windows[1].text).not.toContain('CONTEXT AFTER:');
    expect(windows[1].text).toContain('TARGET:');
  });

  it('defensively truncates a pathologically long single sentence (e.g. bad PDF text extraction)', () => {
    const hugeSentenceText = 'x'.repeat(5000);
    const chunks = [{ text: hugeSentenceText, sentences: [{ id: 's0', start: 0, end: 5000 }] }];
    const [window] = buildSentenceContextWindows(chunks);
    expect(window.text.length).toBeLessThan(2100); // well under the raw 5000
    expect(window.text).toContain('…');
  });

  it('returns a single empty window for no input', () => {
    expect(buildSentenceContextWindows([])).toEqual([{ text: '', validIds: new Set() }]);
  });
});

describe('evenlySpacedIndices', () => {
  it('includes both ends and deterministic interior positions', () => {
    expect(evenlySpacedIndices(10, 3)).toEqual([0, 5, 9]);
    expect(evenlySpacedIndices(4, 6)).toEqual([0, 1, 2, 3]);
  });
});

describe('getDocWindows', () => {
  const sixChunks = Array.from({ length: 6 }, (_, i) => {
    const text = `chunk${i} ` + 'y'.repeat(1990);
    return { text, sentences: [{ id: `a:c${i}:s0`, start: 0, end: text.length }] };
  });

  it('uses the default window budget when no settings are passed', async () => {
    docChunks.mockResolvedValue({ ok: true, result: sixChunks });
    const res = await getDocWindows('repo', 'a');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.windows.length).toBeLessThan(4); // ~3 windows at the 6000 default
  });

  it('respects the resolved graphWindowChars override, matching what buildRepoGraph would actually send', async () => {
    docChunks.mockResolvedValue({ ok: true, result: sixChunks });
    const res = await getDocWindows('repo', 'a', { ...S, graphWindowChars: 4000 } as Settings);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.windows.length).toBeGreaterThanOrEqual(5); // ~1 chunk per window at 4000
  });
});

describe('scoreWindowInformationValue', () => {
  it('scores dense prose with named entities much higher than a dot-leader table-of-contents block', () => {
    const prose =
      "[[a]] Shared Services Canada partnered with Microsoft Azure to modernize the department's cloud infrastructure across multiple regions.";
    const toc = [
      '[[b]] ....................12',
      '[[c]] ....................14',
      '[[d]] ....................16',
      '[[e]] ....................19',
    ].join('\n');

    const proseScore = scoreWindowInformationValue(prose).score;
    const tocScore = scoreWindowInformationValue(toc).score;

    expect(proseScore).toBeGreaterThan(tocScore);
    expect(tocScore).toBeLessThan(0.25);
  });

  it('lowers the repeated-line sub-score for a header seen earlier in the same document, via the shared seenLines set', () => {
    const seen = new Set<string>();
    const header = '[[a]] Annual Report 2024';
    const first = scoreWindowInformationValue(header, seen);
    const second = scoreWindowInformationValue(header, seen);
    expect(second.repeatedLineRatio).toBeGreaterThan(first.repeatedLineRatio);
    expect(second.score).toBeLessThan(first.score);
  });

  it('returns a zero score for an empty window', () => {
    expect(scoreWindowInformationValue('').score).toBe(0);
  });
});

describe('tagDocChunks (single-window compatibility wrapper)', () => {
  it('tags each sentence with its id and collects the valid-id allow-list', () => {
    const { text, validIds } = tagDocChunks([
      {
        text: 'First fact here. Second fact follows.',
        sentences: [
          { id: 'd:c0:s0#a', start: 0, end: 16 },
          { id: 'd:c0:s1#b', start: 17, end: 37 },
        ],
      },
    ]);
    expect(text).toBe('[[d:c0:s0#a]] First fact here.\n[[d:c0:s1#b]] Second fact follows.');
    expect([...validIds]).toEqual(['d:c0:s0#a', 'd:c0:s1#b']);
  });

  it('stops at the char budget (only the first window)', () => {
    const { validIds } = tagDocChunks(
      [{ text: 'aaaa. bbbb.', sentences: [{ id: 'i0', start: 0, end: 5 }, { id: 'i1', start: 6, end: 11 }] }],
      15, // only room for the first tagged line
    );
    expect([...validIds]).toEqual(['i0']);
  });
});

describe('looksTruncated', () => {
  it('flags unbalanced braces/brackets as truncated', () => {
    expect(looksTruncated('{"entities":[{"label":"X"')).toBe(true);
    expect(looksTruncated('{"a":[1,2,3')).toBe(true);
  });
  it('does not flag balanced, complete JSON', () => {
    expect(looksTruncated('{"entities":[{"label":"X"}],"relations":[]}')).toBe(false);
  });
  it('ignores braces/brackets inside string literals', () => {
    expect(looksTruncated('{"summary":"note: {see also} [ref]"}')).toBe(false);
  });
  it('treats empty content as not truncated', () => {
    expect(looksTruncated('')).toBe(false);
  });
});

describe('extractOneDoc', () => {
  it('parses the model JSON and keeps only in-document evidence ids', async () => {
    complete.mockResolvedValue({
      content:
        '{"entities":[{"label":"SSC","type":"org","summary":"s","evidence":["d:c0:s0#a","fabricated"]}],' +
        '"relations":[{"from":"SSC","to":"Azure","relation":"uses","evidence":["d:c0:s1#b"]}]}',
    });
    const out = await extractOneDoc(S, '[[d:c0:s0#a]] ...', new Set(['d:c0:s0#a', 'd:c0:s1#b']));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.extraction.entities[0].evidence).toEqual(['d:c0:s0#a']); // fabricated dropped
      expect(out.extraction.relations[0]).toMatchObject({ from: 'SSC', to: 'Azure', relation: 'uses' });
      expect(out.content).toContain('"SSC"'); // raw response text carried through, for gleaning follow-ups
    }
    expect(complete.mock.calls.at(-1)?.[5]).toEqual(DOC_EXTRACTION_SCHEMA); // requests constrained/schema-guaranteed JSON output
  });

  it('reports a parse_error when the model returns non-JSON prose', async () => {
    complete.mockResolvedValue({ content: 'sorry, I cannot' });
    expect(await extractOneDoc(S, 'x', new Set())).toEqual({ ok: false, reason: 'parse_error' });
  });

  it('reports truncated when the JSON is cut off mid-object', async () => {
    complete.mockResolvedValue({ content: '{"entities":[{"label":"X","evidence":["a"' });
    expect(await extractOneDoc(S, 'x', new Set(['a']))).toEqual({ ok: false, reason: 'truncated' });
  });

  it('recovers a provider-thrown length-limit error (e.g. chat-completions finish_reason:"length") by reading its carried content, instead of the window failing with no truncation classification at all', async () => {
    // Reproduces a real failure: openaiChatAdapter.parseResponse throws
    // (rather than returning) when finish_reason is 'length', even though the
    // provider did generate content -- LlmError.content carries it precisely
    // so a caller like this one isn't left with nothing to classify.
    complete.mockRejectedValue(
      new LlmError('Model reached its output or context limit (finish reason: length).', {
        content: '{"entities":[{"label":"X","evidence":["a"',
      }),
    );
    expect(await extractOneDoc(S, 'x', new Set(['a']))).toEqual({ ok: false, reason: 'truncated' });
  });

  it('does not swallow a length-limit error that carries no content (nothing to recover)', async () => {
    complete.mockRejectedValue(new LlmError('Model reached its output or context limit.'));
    await expect(extractOneDoc(S, 'x', new Set(['a']))).rejects.toThrow('output or context limit');
  });

  it('does not swallow an unrelated error (network failure) even if it happens to be an LlmError', async () => {
    complete.mockRejectedValue(new LlmError('Could not reach the model endpoint.'));
    await expect(extractOneDoc(S, 'x', new Set(['a']))).rejects.toThrow('Could not reach the model endpoint');
  });

  it('reports empty when parsing succeeds but nothing was extracted', async () => {
    complete.mockResolvedValue({ content: '{"entities":[],"relations":[]}' });
    expect(await extractOneDoc(S, 'x', new Set())).toEqual({ ok: false, reason: 'empty' });
  });

  it('uses a promptOverrides.graphExtraction override for the system message, when set', async () => {
    complete.mockResolvedValue({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":[]}],"relations":[]}' });
    const withOverride = { promptOverrides: { graphExtraction: 'CUSTOM GRAPH PROMPT' } } as Settings;
    await extractOneDoc(withOverride, 'x', new Set());
    const messages = complete.mock.calls.at(-1)?.[1];
    expect(messages[0]).toEqual({ role: 'system', content: 'CUSTOM GRAPH PROMPT' });
  });

  it('falls back to the built-in default system message with no override', async () => {
    complete.mockResolvedValue({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":[]}],"relations":[]}' });
    await extractOneDoc(S, 'x', new Set());
    const messages = complete.mock.calls.at(-1)?.[1];
    expect(messages[0].content).toContain('You extract a knowledge graph from ONE document');
  });

  it('routes entity and relationship extraction through the Knowledge Graph role', async () => {
    complete.mockResolvedValue({ content: '{"entities":[],"relations":[]}' });
    await extractOneDoc(S, 'x', new Set());
    expect(resolveModelForRole).toHaveBeenCalledWith(S, 'knowledgeGraph');
  });
});

describe('splitTaggedWindow', () => {
  it('splits a multi-line tagged window into two halves, partitioning validIds by which half each id\'s line falls in', () => {
    const text = '[[a]] Sentence A.\n[[b]] Sentence B.\n[[c]] Sentence C.\n[[d]] Sentence D.';
    const validIds = new Set(['a', 'b', 'c', 'd']);
    const halves = splitTaggedWindow(text, validIds);
    expect(halves).not.toBeNull();
    const [first, second] = halves!;
    expect(first.text).toBe('[[a]] Sentence A.\n[[b]] Sentence B.');
    expect(second.text).toBe('[[c]] Sentence C.\n[[d]] Sentence D.');
    expect([...first.validIds]).toEqual(['a', 'b']);
    expect([...second.validIds]).toEqual(['c', 'd']);
  });

  it('returns null for a single-line window (nothing left to split)', () => {
    expect(splitTaggedWindow('[[a]] Only sentence.', new Set(['a']))).toBeNull();
  });

  it('returns null for an empty window', () => {
    expect(splitTaggedWindow('', new Set())).toBeNull();
  });

  it('drops an id from validIds that is not present in either half (defensive, should not normally happen)', () => {
    const text = '[[a]] Sentence A.\n[[b]] Sentence B.';
    const halves = splitTaggedWindow(text, new Set(['a', 'b', 'phantom']));
    const allIds = [...halves![0].validIds, ...halves![1].validIds];
    expect(allIds.sort()).toEqual(['a', 'b']);
  });
});

describe('extractWindowAdaptive', () => {
  const window = (n: number) => ({
    text: Array.from({ length: n }, (_, i) => `[[s${i}]] Sentence ${i}.`).join('\n'),
    validIds: new Set(Array.from({ length: n }, (_, i) => `s${i}`)),
  });

  it('returns the single extraction on a clean first response, with no retry', async () => {
    complete.mockResolvedValue({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' });
    const result = await extractWindowAdaptive(S, window(4), undefined);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.extractions).toHaveLength(1);
    expect(result.failure).toBeUndefined();
  });

  it('recovers from a truncated response by splitting the window in half and retrying each half', async () => {
    let call = 0;
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      call++;
      if (call === 1) return { content: '{"entities":[{"label":"X"' }; // truncated on the full window
      const id = messages[1].content.match(/\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 't', summary: id, evidence: [id] }], relations: [] }) };
    });
    const result = await extractWindowAdaptive(S, window(4), undefined);
    expect(complete).toHaveBeenCalledTimes(3); // 1 failed full attempt + 2 half-window retries
    expect(result.failure).toBeUndefined();
    expect(result.extractions).toHaveLength(2); // one per successful half
  });

  it('recovers from a provider-thrown length-limit error the same way as a resolved-truncated response (the real chat-completions finish_reason:"length" case)', async () => {
    let call = 0;
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      call++;
      if (call === 1) {
        throw new LlmError('Model reached its output or context limit (finish reason: length).', {
          content: '{"entities":[{"label":"X"', // the model DID generate this much before hitting the limit
        });
      }
      const id = messages[1].content.match(/\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 't', summary: id, evidence: [id] }], relations: [] }) };
    });
    const result = await extractWindowAdaptive(S, window(4), undefined);
    expect(complete).toHaveBeenCalledTimes(3); // 1 failed full attempt + 2 half-window retries
    expect(result.failure).toBeUndefined();
    expect(result.extractions).toHaveLength(2); // one per successful half
  });

  it('recovers from a parse_error response the same way as truncated', async () => {
    let call = 0;
    complete.mockImplementation(async () => {
      call++;
      if (call === 1) return { content: 'not json at all' };
      return { content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' };
    });
    const result = await extractWindowAdaptive(S, window(4), undefined);
    expect(result.failure).toBeUndefined();
    expect(result.extractions.length).toBeGreaterThan(0);
  });

  it('keeps whatever one half recovered even when the other half fails outright', async () => {
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const text = messages[1].content as string;
      if (text.includes('s0')) {
        return { content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' };
      }
      return { content: '{"entities":[],"relations":[]}' }; // the half containing s1-s3 comes back empty
    });
    const result = await extractWindowAdaptive(S, window(4), undefined);
    expect(result.failure).toBeUndefined(); // 'empty' isn't a failure
    expect(result.extractions).toHaveLength(1);
  });

  it('gives up after MAX_TRUNCATION_SPLIT_DEPTH and reports the failure once nothing at all can be recovered', async () => {
    complete.mockResolvedValue({ content: '{"entities":[{"label":"X"' }); // always truncated, at every depth
    const result = await extractWindowAdaptive(S, window(8), undefined);
    expect(result.extractions).toHaveLength(0);
    expect(result.failure).toBe('truncated');
    // 1 (depth 0, whole) + 2 (depth 1, halves) + 4 (depth 2, quarters) = 7 calls;
    // depth 2 doesn't split further, so it stops there.
    expect(complete).toHaveBeenCalledTimes(7);
  });

  it('treats a genuinely empty extraction as success with no retry (not a truncation to recover from)', async () => {
    complete.mockResolvedValue({ content: '{"entities":[],"relations":[]}' });
    const result = await extractWindowAdaptive(S, window(4), undefined);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.extractions).toEqual([]);
    expect(result.failure).toBeUndefined();
  });

  describe('gleaning (glean=true)', () => {
    it('runs one gleaning follow-up after a successful first pass and merges what it finds', async () => {
      let call = 0;
      complete.mockImplementation(async () => {
        call++;
        if (call === 1) return { content: '{"entities":[{"label":"First","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' };
        return { content: '{"entities":[{"label":"Missed","type":"t","summary":"s","evidence":["s1"]}],"relations":[]}' };
      });

      const result = await extractWindowAdaptive(S, window(4), undefined, 0, true);

      expect(complete).toHaveBeenCalledTimes(2); // 1 first pass + 1 gleaning follow-up
      expect(result.extractions).toHaveLength(2);
      expect(result.extractions.map((e) => e.entities[0].label)).toEqual(['First', 'Missed']);
      expect(complete.mock.calls[0][5]).toEqual(DOC_EXTRACTION_SCHEMA);
      expect(complete.mock.calls[1][5]).toEqual(DOC_EXTRACTION_SCHEMA);
    });

    it('sends the gleaning follow-up as a continuation of the same exchange (system, user, assistant=first response, user=gleaning prompt)', async () => {
      complete.mockImplementation(async () => ({ content: '{"entities":[],"relations":[]}' }));
      complete.mockResolvedValueOnce({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' });

      await extractWindowAdaptive(S, window(4), undefined, 0, true);

      const gleaningMessages = complete.mock.calls[1][1];
      expect(gleaningMessages).toHaveLength(4);
      expect(gleaningMessages[2]).toEqual({
        role: 'assistant',
        content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}',
      });
      expect(gleaningMessages[3].role).toBe('user');
    });

    it('adds nothing when the gleaning pass reports it found nothing extra', async () => {
      complete.mockImplementation(async () => ({ content: '{"entities":[],"relations":[]}' }));
      complete.mockResolvedValueOnce({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' });

      const result = await extractWindowAdaptive(S, window(4), undefined, 0, true);

      expect(complete).toHaveBeenCalledTimes(2);
      expect(result.extractions).toHaveLength(1);
    });

    it('swallows a gleaning failure (bad JSON) without affecting the already-successful first extraction', async () => {
      complete.mockResolvedValueOnce({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' });
      complete.mockResolvedValueOnce({ content: 'not json at all' });

      const result = await extractWindowAdaptive(S, window(4), undefined, 0, true);

      expect(result.failure).toBeUndefined();
      expect(result.extractions).toHaveLength(1);
    });

    it('never glean on a window recovered via the truncation-retry split (depth > 0)', async () => {
      let call = 0;
      complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
        call++;
        if (call === 1) return { content: '{"entities":[{"label":"X"' }; // truncated on the full window
        const id = messages[1].content.match(/\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
        return { content: JSON.stringify({ entities: [{ label: 'Half', type: 't', summary: 's', evidence: [id] }], relations: [] }) };
      });

      const result = await extractWindowAdaptive(S, window(4), undefined, 0, true);

      // 1 failed full attempt + 2 half-window retries, and NO gleaning calls
      // for either successful half (both are at depth 1, not depth 0).
      expect(complete).toHaveBeenCalledTimes(3);
      expect(result.extractions).toHaveLength(2);
    });

    it('does not glean when glean=false (the default)', async () => {
      complete.mockResolvedValue({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' });
      await extractWindowAdaptive(S, window(4), undefined);
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('uses a promptOverrides.graphExtractionGleaning override for the follow-up prompt, when set', async () => {
      complete.mockResolvedValueOnce({ content: '{"entities":[{"label":"X","type":"t","summary":"s","evidence":["s0"]}],"relations":[]}' });
      complete.mockResolvedValueOnce({ content: '{"entities":[],"relations":[]}' });
      const withOverride = { promptOverrides: { graphExtractionGleaning: 'CUSTOM GLEANING PROMPT' } } as Settings;

      await extractWindowAdaptive(withOverride, window(4), undefined, 0, true);

      const gleaningMessages = complete.mock.calls[1][1];
      expect(gleaningMessages[3]).toEqual({ role: 'user', content: 'CUSTOM GLEANING PROMPT' });
    });
  });
});

describe('summarizeCommunities', () => {
  it('summarizes each detected community and grounds it to community evidence', async () => {
    const g = emptyDocGraph();
    // Three densely-connected members (>= COMMUNITY_MIN_SIZE) so a community forms.
    mergeExtraction(
      g,
      {
        entities: [],
        relations: [
          { from: 'A', to: 'B', relation: 'r', evidence: ['s1'] },
          { from: 'B', to: 'C', relation: 'r', evidence: ['s2'] },
          { from: 'A', to: 'C', relation: 'r', evidence: ['s3'] },
        ],
      },
      'doc-1',
    );
    complete.mockResolvedValue({ content: '{"title":"Cluster","summary":"They relate.","evidence":["s1","not-in-cluster"]}' });

    const comms = await summarizeCommunities(S, g);
    expect(comms).toHaveLength(1);
    expect(comms[0].title).toBe('Cluster');
    expect(comms[0].nodeIds.length).toBe(3);
    expect(comms[0].evidenceSentenceIds).toEqual(['s1']); // fabricated id filtered out
    expect(complete.mock.calls[0][5]).toEqual(COMMUNITY_SUMMARY_SCHEMA);
  });

  it('returns [] when there are no communities', async () => {
    expect(await summarizeCommunities(S, emptyDocGraph())).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses a promptOverrides.communitySummary override for the system message, when set', async () => {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [],
        relations: [
          { from: 'A', to: 'B', relation: 'r', evidence: ['s1'] },
          { from: 'B', to: 'C', relation: 'r', evidence: ['s2'] },
          { from: 'A', to: 'C', relation: 'r', evidence: ['s3'] },
        ],
      },
      'doc-1',
    );
    complete.mockResolvedValue({ content: '{"title":"T","summary":"S","evidence":[]}' });
    const withOverride = { promptOverrides: { communitySummary: 'CUSTOM COMMUNITY PROMPT' } } as Settings;
    await summarizeCommunities(withOverride, g);
    const messages = complete.mock.calls.at(-1)?.[1];
    expect(messages[0]).toEqual({ role: 'system', content: 'CUSTOM COMMUNITY PROMPT' });
  });

  it('routes community summaries through the Knowledge Graph role', async () => {
    const g = emptyDocGraph();
    mergeExtraction(g, {
      entities: [],
      relations: [
        { from: 'A', to: 'B', relation: 'r', evidence: ['s1'] },
        { from: 'B', to: 'C', relation: 'r', evidence: ['s2'] },
        { from: 'A', to: 'C', relation: 'r', evidence: ['s3'] },
      ],
    }, 'd');
    complete.mockResolvedValue({ content: '{"title":"T","summary":"S","evidence":["s1"]}' });
    await summarizeCommunities(S, g);
    expect(resolveModelForRole).toHaveBeenCalledWith(S, 'knowledgeGraph');
  });
});

describe('summarizeCommunitiesIncremental', () => {
  function twoClusterGraph() {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [],
        relations: [
          { from: 'A', to: 'B', relation: 'r', evidence: ['s1'] },
          { from: 'B', to: 'C', relation: 'r', evidence: ['s2'] },
          { from: 'X', to: 'Y', relation: 'r', evidence: ['s3'] },
          { from: 'Y', to: 'Z', relation: 'r', evidence: ['s4'] },
        ],
      },
      'doc-1',
    );
    return g;
  }

  it('gives an LLM summary only to the community containing a touched node; the other stays extractive', async () => {
    const g = twoClusterGraph();
    const nodeA = g.nodes.find((n) => n.label === 'A')!;
    complete.mockResolvedValue({ content: '{"title":"Touched theme","summary":"Fresh from the model.","evidence":["s1"]}' });

    const result = await summarizeCommunitiesIncremental(S, g, new Set([nodeA.id]));

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    const touchedComm = result.find((c) => c.nodeIds.includes(nodeA.id))!;
    const untouchedComm = result.find((c) => !c.nodeIds.includes(nodeA.id))!;
    expect(touchedComm.method).toBe('llm');
    expect(touchedComm.title).toBe('Touched theme');
    expect(untouchedComm.method).toBe('extractive');

    // The untouched community's output matches calling the extractive path directly.
    const raw = detectCommunities(g, { minSize: 3, maxCommunities: 12 }).find((c) => !c.nodeIds.includes(nodeA.id))!;
    expect(untouchedComm).toEqual(extractiveCommunitySummary(g, raw));
  });

  it('falls back to extractive for every community when nothing is touched, with zero model calls', async () => {
    const g = twoClusterGraph();
    const result = await summarizeCommunitiesIncremental(S, g, new Set());
    expect(complete).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.method === 'extractive')).toBe(true);
  });
});

describe('dedupeEntitiesByEmbedding', () => {
  it('merges a near-duplicate pair when embeddings are similar, and records the embedder identity', async () => {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [
          { label: 'Acme Corp.', type: 'x', summary: 'A vendor.', evidence: ['s1'] },
          { label: 'Acme Corporation', type: 'x', summary: 'A longer vendor bio.', evidence: ['s2'] },
        ],
        relations: [],
      },
      'd1',
    );
    expect(g.nodes).toHaveLength(2); // punctuation differs, so exact-label matching didn't merge them

    embedChunks.mockResolvedValueOnce([
      [1, 0, 0],
      [0.99, Math.sqrt(1 - 0.99 ** 2), 0],
    ]);

    const result = await dedupeEntitiesByEmbedding(S, g);

    expect(result.mergedCount).toBe(1);
    expect(g.nodes).toHaveLength(1);
    expect(g.embedModel).toBe('local:test-embed-model');
  });

  it('makes zero embedding calls on a stable graph where every node already has an embedding', async () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'Solo', type: 'x', summary: '', evidence: ['s1'] }], relations: [] }, 'd1');
    await dedupeEntitiesByEmbedding(S, g);
    embedChunks.mockClear();

    await dedupeEntitiesByEmbedding(S, g);

    expect(embedChunks).not.toHaveBeenCalled();
  });

  it('recomputes all embeddings when the embedder identity changes', async () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'Solo', type: 'x', summary: '', evidence: ['s1'] }], relations: [] }, 'd1');
    await dedupeEntitiesByEmbedding(S, g);
    embedChunks.mockClear();
    embedderId.mockReturnValueOnce('local:different-model');

    await dedupeEntitiesByEmbedding(S, g);

    expect(embedChunks).toHaveBeenCalledTimes(1);
    expect(g.embedModel).toBe('local:different-model');
  });
});

describe('enrichRelationTypes', () => {
  function coOccurGraph(pairs: Array<[string, string, string]>) {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [],
        relations: pairs.map(([from, to, sentenceId]) => ({ from, to, relation: 'co-occurs with', evidence: [sentenceId] })),
      },
      'd1',
    );
    return g;
  }

  it('upgrades a generic co-occurrence edge to the relation the model names', async () => {
    const g = coOccurGraph([['Alice', 'Acme', 's1']]);
    complete.mockResolvedValue({ content: '{"relation":"works for"}' });

    const { upgradedCount } = await enrichRelationTypes(S, 'repo1', g);

    expect(upgradedCount).toBe(1);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].relation).toBe('works for');
    expect(resolveSentenceCitations).toHaveBeenCalledWith('repo1', ['s1']);
    const userMsg = complete.mock.calls[0][1][1].content as string;
    expect(userMsg).toContain('Alice');
    expect(userMsg).toContain('Acme');
    expect(userMsg).toContain('Sentence text for s1.');
    expect(complete.mock.calls[0][5]).toEqual(RELATION_TYPING_SCHEMA);
  });

  it('leaves the edge generic when the model itself returns "co-occurs with"', async () => {
    const g = coOccurGraph([['Alice', 'Acme', 's1']]);
    complete.mockResolvedValue({ content: '{"relation":"co-occurs with"}' });

    const { upgradedCount } = await enrichRelationTypes(S, 'repo1', g);

    expect(upgradedCount).toBe(0);
    expect(g.edges[0].relation).toBe('co-occurs with');
  });

  it('leaves the edge generic on a model/parse failure for that edge', async () => {
    const g = coOccurGraph([['Alice', 'Acme', 's1']]);
    complete.mockRejectedValue(new Error('boom'));

    const { upgradedCount } = await enrichRelationTypes(S, 'repo1', g);

    expect(upgradedCount).toBe(0);
    expect(g.edges[0].relation).toBe('co-occurs with');
  });

  it('never touches an already-typed relation', async () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [], relations: [{ from: 'Alice', to: 'Acme', relation: 'manages', evidence: ['s1'] }] }, 'd1');

    const { upgradedCount } = await enrichRelationTypes(S, 'repo1', g);

    expect(upgradedCount).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('caps LLM calls at `limit` regardless of how many co-occurrence edges exist', async () => {
    const pairs: Array<[string, string, string]> = Array.from({ length: 20 }, (_, i) => [`E${i}a`, `E${i}b`, `s${i}`]);
    const g = coOccurGraph(pairs);
    complete.mockResolvedValue({ content: '{"relation":"relates to"}' });

    const { upgradedCount } = await enrichRelationTypes(S, 'repo1', g, { limit: 5 });

    expect(complete).toHaveBeenCalledTimes(5);
    expect(upgradedCount).toBe(5);
  });

  it('returns immediately with zero LLM/citation calls when there are no co-occurrence edges', async () => {
    const g = emptyDocGraph();
    const { upgradedCount } = await enrichRelationTypes(S, 'repo1', g);
    expect(upgradedCount).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(resolveSentenceCitations).not.toHaveBeenCalled();
  });

  it('routes relation typing through the Knowledge Graph role and the graphRelationTyping prompt override', async () => {
    const g = coOccurGraph([['Alice', 'Acme', 's1']]);
    complete.mockResolvedValue({ content: '{"relation":"works for"}' });
    const withOverride = { promptOverrides: { graphRelationTyping: 'CUSTOM RELATION PROMPT' } } as Settings;

    await enrichRelationTypes(withOverride, 'repo1', g);

    expect(resolveModelForRole).toHaveBeenCalledWith(withOverride, 'knowledgeGraph');
    expect(complete.mock.calls[0][1][0]).toEqual({ role: 'system', content: 'CUSTOM RELATION PROMPT' });
  });
});

describe('buildRepoGraphQuick', () => {
  const THREE_PEOPLE_TEXT = 'Alice met Bob and Carol.';
  const threePeopleSpans = [
    { label: 'PER', start: 0, end: 5, score: 0.9 }, // Alice
    { label: 'PER', start: 10, end: 13, score: 0.9 }, // Bob
    { label: 'PER', start: 18, end: 23, score: 0.9 }, // Carol
  ];

  function setUpOneDoc() {
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({
      ok: true,
      result: [{ text: THREE_PEOPLE_TEXT, sentences: [{ id: 'a:c0:s0', start: 0, end: THREE_PEOPLE_TEXT.length }] }],
    });
    graphSet.mockResolvedValue({ ok: true });
    nerLocal.mockResolvedValueOnce({ ok: true, spans: [threePeopleSpans], model: 'test-ner-model' });
  }

  it('builds the same NER backbone as Fast, then layers bounded LLM enrichment on top', async () => {
    setUpOneDoc();
    complete.mockResolvedValue({ content: '{"title":"Friends","summary":"They met.","evidence":["a:c0:s0"]}' });

    const result = await buildRepoGraphQuick(S, 'repo');

    expect(result.ok).toBe(true);
    expect(result.graph?.nodes.map((n) => n.label).sort()).toEqual(['Alice', 'Bob', 'Carol']);
    expect(result.graph?.edges).toHaveLength(3); // co-occurrence backbone, same as Fast
    // Deliberately untouched — same as Fast, these belong to the Full-mode
    // window/sentence LLM coverage state machine only.
    expect(result.graph?.processedDocIds).toEqual([]);
    expect(result.graph?.coverageMode).toBeUndefined();
    // Community summary went through the model (not extractive), unlike Fast.
    expect(complete).toHaveBeenCalled();
    expect(result.graph?.communities?.[0].method).toBe('llm');
    expect(result.graph?.communities?.[0].title).toBe('Friends');
  });

  it('spends only a fixed, corpus-size-independent number of LLM calls (relation typing + one per community), never one per document/window', async () => {
    // Two DISTINCT 3-person clusters (different names per doc, so entity
    // resolution by label doesn't merge them) -> 2 documents, 6 unique
    // co-occurrence edges, 2 disconnected communities. If LLM calls scaled
    // with corpus size the way the old window/sentence extraction did, this
    // would cost far more than a 1-document build; instead it should cost
    // exactly the *shape* of call count (one relation-typing call per generic
    // edge, one summary per community) — nothing tied to document count.
    const DOC_B_TEXT = 'Xavier met Yolanda and Zack.';
    const docBSpans = [
      { label: 'PER', start: 0, end: 6, score: 0.9 }, // Xavier
      { label: 'PER', start: 11, end: 18, score: 0.9 }, // Yolanda
      { label: 'PER', start: 23, end: 27, score: 0.9 }, // Zack
    ];
    graphSnapshot.mockResolvedValue({
      ok: true,
      result: { docs: [{ id: 'a', name: 'A.md' }, { id: 'b', name: 'B.md' }], corpusRevision: 1 },
    });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockImplementation(async (_repo: string, id: string) => ({
      ok: true,
      result: [
        {
          text: id === 'a' ? THREE_PEOPLE_TEXT : DOC_B_TEXT,
          sentences: [{ id: `${id}:c0:s0`, start: 0, end: (id === 'a' ? THREE_PEOPLE_TEXT : DOC_B_TEXT).length }],
        },
      ],
    }));
    graphSet.mockResolvedValue({ ok: true });
    nerLocal.mockResolvedValueOnce({ ok: true, spans: [threePeopleSpans], model: 'test-ner-model' });
    nerLocal.mockResolvedValueOnce({ ok: true, spans: [docBSpans], model: 'test-ner-model' });
    complete.mockImplementation(async (_role: unknown, messages: Array<{ content: string }>) => {
      // Relation-typing calls ask about "Entity A"; community-summary calls don't.
      return messages[1].content.startsWith('Entity A')
        ? { content: '{"relation":"knows"}' }
        : { content: '{"title":"T","summary":"S","evidence":[]}' };
    });

    const result = await buildRepoGraphQuick(S, 'repo');

    expect(result.ok).toBe(true);
    expect(result.graph?.nodes).toHaveLength(6);
    // 6 co-occurrence edges total -> 6 relation-typing calls; 2 communities -> 2 summary calls. Fixed by graph shape, not by document count or window count.
    expect(complete).toHaveBeenCalledTimes(8);
    expect(result.graph?.edges.every((e) => e.relation === 'knows')).toBe(true);
  });

  it('does not spend any enrichment calls on a no-op rebuild (nothing new, communities already exist)', async () => {
    setUpOneDoc();
    complete.mockResolvedValue({ content: '{"title":"Friends","summary":"They met.","evidence":[]}' });
    const first = await buildRepoGraphQuick(S, 'repo');
    expect(first.ok).toBe(true);

    // Second call: same doc, unchanged content (fastContentHash matches), so
    // the NER backbone makes zero touched nodes and nothing is dirty.
    graphGetRaw.mockResolvedValue({ ok: true, result: first.graph });
    complete.mockClear();

    const second = await buildRepoGraphQuick(S, 'repo');

    expect(second.ok).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('routes enrichment through the Knowledge Graph role', async () => {
    setUpOneDoc();
    complete.mockResolvedValue({ content: '{"title":"T","summary":"S","evidence":[]}' });

    await buildRepoGraphQuick(S, 'repo');

    expect(resolveModelForRole).toHaveBeenCalledWith(S, 'knowledgeGraph');
  });

  it('skips a document whose content is unchanged since its last backbone pass', async () => {
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    const chunks = [{ text: THREE_PEOPLE_TEXT, sentences: [{ id: 'a:c0:s0', start: 0, end: THREE_PEOPLE_TEXT.length }] }];
    const contentHash = shortHash(chunks.map((c) => c.text).join('\n'));
    const existing = emptyDocGraph();
    existing.docCoverage = {
      a: { totalWindows: 0, selectedWindows: [], completedWindows: [], failedWindows: [], fastContentHash: contentHash },
    };
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });

    const result = await buildRepoGraphQuick(S, 'repo');

    expect(result.ok).toBe(true);
    expect(nerLocal).not.toHaveBeenCalled();
    // No new nodes touched and no prior communities -> nothing to enrich.
    expect(complete).not.toHaveBeenCalled();
  });

  it('rebuild:true reprocesses a document even if its backbone content hash is unchanged', async () => {
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    const chunks = [{ text: THREE_PEOPLE_TEXT, sentences: [{ id: 'a:c0:s0', start: 0, end: THREE_PEOPLE_TEXT.length }] }];
    const contentHash = shortHash(chunks.map((c) => c.text).join('\n'));
    const existing = emptyDocGraph();
    existing.docCoverage = {
      a: { totalWindows: 0, selectedWindows: [], completedWindows: [], failedWindows: [], fastContentHash: contentHash },
    };
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    nerLocal.mockResolvedValueOnce({ ok: true, spans: [threePeopleSpans], model: 'test-ner-model' });
    complete.mockResolvedValue({ content: '{"title":"T","summary":"S","evidence":[]}' });

    const result = await buildRepoGraphQuick(S, 'repo', { rebuild: true });

    expect(result.ok).toBe(true);
    expect(nerLocal).toHaveBeenCalledTimes(1);
  });

  it('records a warning and continues past a document whose NER pass fails', async () => {
    graphSnapshot.mockResolvedValue({
      ok: true,
      result: { docs: [{ id: 'a', name: 'A.md' }, { id: 'b', name: 'B.md' }], corpusRevision: 1 },
    });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockImplementation(async (_repo: string, id: string) => ({
      ok: true,
      result: [{ text: THREE_PEOPLE_TEXT, sentences: [{ id: `${id}:c0:s0`, start: 0, end: THREE_PEOPLE_TEXT.length }] }],
    }));
    graphSet.mockResolvedValue({ ok: true });
    nerLocal.mockImplementationOnce(async () => ({ ok: false, error: 'model failed to load' })); // doc 'a' (sorted first)
    nerLocal.mockResolvedValueOnce({ ok: true, spans: [threePeopleSpans], model: 'test-ner-model' }); // doc 'b'
    complete.mockResolvedValue({ content: '{"title":"T","summary":"S","evidence":[]}' });

    const result = await buildRepoGraphQuick(S, 'repo');

    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => w.includes('model failed to load'))).toBe(true);
    // Doc 'b' still succeeded despite doc 'a' failing.
    expect(result.graph?.docCoverage?.b?.fastContentHash).toBeDefined();
    expect(result.graph?.docCoverage?.a?.fastContentHash).toBeUndefined();
  });

  it('checkpoints the deduped graph before enrichment, not just once at the end', async () => {
    // "Acme Corp." and "Acme Corporation" -- different normalized labels, so
    // exact-label matching won't merge them; forcing near-identical embeddings
    // makes the embedding-dedup pass merge them, so mergedCount > 0 and the
    // intermediate checkpoint after dedup actually fires. The single merged
    // node has no surviving co-occurrence edge (the pair's only edge becomes
    // a self-loop and is dropped) and too few nodes for a community, so
    // enrichment makes zero LLM calls and thus adds no further checkpoint --
    // same checkpoint count as the plain NER backbone would produce.
    const text = 'Acme Corp. met Acme Corporation.';
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: [{ text, sentences: [{ id: 'a:c0:s0', start: 0, end: text.length }] }] });
    nerLocal.mockResolvedValueOnce({
      ok: true,
      spans: [[
        { label: 'ORG', start: 0, end: 10, score: 0.9 }, // "Acme Corp."
        { label: 'ORG', start: 15, end: 31, score: 0.9 }, // "Acme Corporation"
      ]],
      model: 'test-ner-model',
    });
    embedChunks.mockResolvedValueOnce([
      [1, 0, 0],
      [0.99, Math.sqrt(1 - 0.99 ** 2), 0],
    ]);
    const snapshots: Array<{ nodes: unknown[]; communities?: unknown[] }> = [];
    graphSet.mockImplementation(async (_repo: string, graph: { nodes: unknown[]; communities?: unknown[] }) => {
      snapshots.push(JSON.parse(JSON.stringify(graph)));
      return { ok: true };
    });

    const result = await buildRepoGraphQuick(S, 'repo');

    expect(result.ok).toBe(true);
    expect(complete).not.toHaveBeenCalled(); // no edges to type, no community to summarize
    // Extraction checkpoint (1 doc), dedup checkpoint, final checkpoint = 3.
    expect(snapshots.length).toBe(3);
    const dedupSnapshot = snapshots[1];
    const finalSnapshot = snapshots[2];
    expect(dedupSnapshot.nodes).toHaveLength(1); // already merged down to 1 node at the dedup checkpoint
    expect(dedupSnapshot.communities).toBeUndefined(); // enrichment hasn't run yet
    expect(finalSnapshot.nodes).toHaveLength(1);
    expect(finalSnapshot.communities).toEqual([]); // now computed (too few nodes to form a community, but the field is set)
  });
});

describe('buildRepoGraphInstant', () => {
  const PER_DIM_SCALE = [1, 1, 1];
  function mockVectors(raw: number[][]) {
    const dim = 3;
    const packed = new Int8Array(raw.length * dim);
    raw.forEach((v, i) => packed.set(quantizeVector(normalizeVector(v), PER_DIM_SCALE), i * dim));
    return { ok: true, result: { vectors: packed, dim, perDimScale: PER_DIM_SCALE } };
  }

  it('clusters already-computed embeddings into topic nodes, with zero model calls, preserving prior entity nodes', async () => {
    graphSnapshot.mockResolvedValue({
      ok: true,
      result: { docs: [{ id: 'a', name: 'A.md' }, { id: 'b', name: 'B.md' }], corpusRevision: 1 },
    });
    const existing = emptyDocGraph();
    existing.nodes = [
      { id: 'n1', type: 'person', label: 'Alice', aliases: [], summary: '', evidenceSentenceIds: [], docIds: ['a'] },
    ];
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockImplementation(async (_repo: string, id: string) => ({
      ok: true,
      result:
        id === 'a'
          ? [
              { chunkId: 'a:c0', text: 'apple orchard harvest report', sentences: [{ id: 'a:c0:s0', start: 0, end: 5 }] },
              { chunkId: 'a:c1', text: 'quarterly financial summary', sentences: [{ id: 'a:c1:s0', start: 0, end: 5 }] },
            ]
          : [{ chunkId: 'b:c0', text: 'another apple orchard note', sentences: [{ id: 'b:c0:s0', start: 0, end: 5 }] }],
    }));
    docVectors.mockImplementation(async (_repo: string, id: string) =>
      id === 'a' ? mockVectors([[1, 0, 0], [0, 1, 0]]) : mockVectors([[0.99, Math.sqrt(1 - 0.99 ** 2), 0]]),
    );
    graphSet.mockResolvedValue({ ok: true });

    const result = await buildRepoGraphInstant('repo');

    expect(result.ok).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(nerLocal).not.toHaveBeenCalled();
    expect(embedChunks).not.toHaveBeenCalled(); // zero model/embedding calls -- vectors were already computed
    // Prior entity node from another tier is untouched.
    expect(result.graph?.nodes.find((n) => n.id === 'n1')).toMatchObject({ type: 'person', label: 'Alice' });
    // At least one new topic-type node was created from clustering.
    const topics = result.graph?.nodes.filter((n) => n.type === 'topic') ?? [];
    expect(topics.length).toBeGreaterThan(0);
    expect(topics[0].label.length).toBeGreaterThan(0);
    expect(graphSet).toHaveBeenCalled();
  });

  it('fully replaces prior topic nodes on a rebuild rather than accumulating duplicates', async () => {
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    docChunks.mockResolvedValue({
      ok: true,
      result: [
        { chunkId: 'a:c0', text: 'apple orchard harvest', sentences: [{ id: 'a:c0:s0', start: 0, end: 5 }] },
        { chunkId: 'a:c1', text: 'apple harvest report', sentences: [{ id: 'a:c1:s0', start: 0, end: 5 }] },
      ],
    });
    docVectors.mockResolvedValue(mockVectors([[1, 0, 0], [0.98, Math.sqrt(1 - 0.98 ** 2), 0]]));
    graphSet.mockResolvedValue({ ok: true });

    graphGetRaw.mockResolvedValueOnce({ ok: true, result: null });
    const first = await buildRepoGraphInstant('repo');
    expect(first.ok).toBe(true);
    const firstTopicCount = first.graph?.nodes.filter((n) => n.type === 'topic').length ?? 0;
    expect(firstTopicCount).toBeGreaterThan(0);

    graphGetRaw.mockResolvedValueOnce({ ok: true, result: first.graph });
    const second = await buildRepoGraphInstant('repo');
    expect(second.ok).toBe(true);
    const secondTopicCount = second.graph?.nodes.filter((n) => n.type === 'topic').length ?? 0;
    expect(secondTopicCount).toBe(firstTopicCount); // replaced, not accumulated
  });

  it('returns a clear error when no documents have embedded chunks yet', async () => {
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: [{ chunkId: 'a:c0', text: 'text', sentences: [] }] });
    docVectors.mockResolvedValue({ ok: true, result: { vectors: new Int8Array(0), dim: 0, perDimScale: [] } });

    const result = await buildRepoGraphInstant('repo');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No embedded chunks');
  });
});

describe('buildRepoGraph corpus revision', () => {
  it('rejects a checkpoint when the repository changes during extraction', async () => {
    graphSnapshot.mockResolvedValue({
      ok: true,
      result: { docs: [{ id: 'doc-1', name: 'a.md' }], corpusRevision: 4 },
    });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({
      ok: true,
      result: [{ text: 'A fact.', sentences: [{ id: 'doc-1:c0:s0#a', start: 0, end: 7 }] }],
    });
    complete.mockResolvedValue({
      content: '{"entities":[{"label":"A","type":"x","summary":"s","evidence":["doc-1:c0:s0#a"]}],"relations":[]}',
    });
    graphSet.mockResolvedValue({
      ok: false,
      error: 'Repository changed while the graph was being built. Rebuild the graph.',
    });

    const result = await buildRepoGraph(S, 'repo');

    expect(result).toEqual({
      ok: false,
      error: 'Repository changed while the graph was being built. Rebuild the graph.',
    });
    expect(graphSet).toHaveBeenCalledWith('repo', expect.objectContaining({ corpusRevision: 4 }), 4);
  });
});

describe('buildRepoGraph coverage', () => {
  const longDoc = (docId: string, count = 8) => Array.from({ length: count }, (_, i) => {
    const text = `${docId}-${i} ` + 'x'.repeat(12_100);
    return { text, sentences: [{ id: `${docId}:c${i}:s0`, start: 0, end: text.length }] };
  });

  it('a small graphWindowChars override (e.g. for a low-context local model) splits the same document into more, smaller windows', async () => {
    // 6 chunks of ~2000 chars each -- at the default 6000 budget these mostly
    // accumulate 2-per-window; at a 4000 override, only ~1 fits per window.
    const chunks = Array.from({ length: 6 }, (_, i) => {
      const text = `chunk${i} ` + 'y'.repeat(1990);
      return { text, sentences: [{ id: `a:c${i}:s0`, start: 0, end: text.length }] };
    });
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const defaultResult = await buildRepoGraph(S, 'repo', { mode: 'full' });
    const overrideResult = await buildRepoGraph({ ...S, graphWindowChars: 4000 } as Settings, 'repo', { mode: 'full' });

    const defaultWindows = defaultResult.graph?.docCoverage?.a.totalWindows ?? 0;
    const overrideWindows = overrideResult.graph?.docCoverage?.a.totalWindows ?? 0;
    expect(overrideWindows).toBeGreaterThan(defaultWindows);
  });

  it('graphExtractionStrategy: "sentence" produces one window per sentence (far more than window mode) and uses the target-sentence prompt', async () => {
    // 5 short sentences across 2 chunks -- at the default 6000-char budget
    // these all fit in ONE window; in sentence mode, 5 windows (one/sentence).
    const chunks = [
      {
        text: 'Brian reviewed the pipeline. He said PDF extraction was unreliable.',
        sentences: [
          { id: 'a:c0:s0', start: 0, end: 28 },
          { id: 'a:c0:s1', start: 29, end: 68 },
        ],
      },
      {
        text: 'Josh agreed to investigate. He filed a ticket. Brian thanked him.',
        sentences: [
          { id: 'a:c1:s0', start: 0, end: 27 },
          { id: 'a:c1:s1', start: 28, end: 46 },
          { id: 'a:c1:s2', start: 47, end: 65 },
        ],
      },
    ];
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async () => ({ content: '{"entities":[],"relations":[]}' }));

    const windowModeResult = await buildRepoGraph(S, 'repo', { mode: 'full' });
    const sentenceModeResult = await buildRepoGraph(
      { ...S, graphExtractionStrategy: 'sentence' } as Settings,
      'repo',
      { mode: 'full' },
    );

    expect(windowModeResult.graph?.docCoverage?.a.totalWindows).toBe(1);
    expect(sentenceModeResult.graph?.docCoverage?.a.totalWindows).toBe(5);

    // The last call in sentence mode used the target-sentence system prompt.
    const lastSystemMessage = complete.mock.calls.at(-1)?.[1]?.[0]?.content as string;
    expect(lastSystemMessage).toContain('You extract facts from ONE target sentence');
  });

  it('quick mode samples every document from beginning to end', async () => {
    graphSnapshot.mockResolvedValue({
      ok: true,
      result: { docs: [{ id: 'b', name: 'B.md' }, { id: 'a', name: 'A.md' }], corpusRevision: 1 },
    });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockImplementation(async (_repo: string, id: string) => ({ ok: true, result: longDoc(id) }));
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'quick' });

    expect(result.ok).toBe(true);
    expect(result.graph?.docCoverage?.a.selectedWindows).toEqual([0, 1, 3, 4, 6, 7]);
    expect(result.graph?.docCoverage?.b.selectedWindows).toEqual([0, 1, 3, 4, 6, 7]);
    expect(result.graph?.processedDocIds.sort()).toEqual(['a', 'b']);
    expect(result.graph?.coverageMode).toBe('quick');
    // Extraction now runs in bounded-concurrency batches flattened across all
    // pending windows (not strictly round-robin per document), so only
    // presence — not position — of each window's call is guaranteed.
    const extractionInputs = complete.mock.calls.map((call) => call[1][1].content as string);
    expect(extractionInputs).toContainEqual(expect.stringContaining('[[a:c0:s0]]'));
    expect(extractionInputs).toContainEqual(expect.stringContaining('[[b:c0:s0]]'));
    expect(extractionInputs).toContainEqual(expect.stringContaining('[[a:c7:s0]]'));
    expect(extractionInputs).toContainEqual(expect.stringContaining('[[b:c7:s0]]'));
    expect(extractionInputs).toHaveLength(12); // 6 selected windows x 2 docs, each called exactly once
    expect(result.warnings?.join(' ')).toContain('Full Coverage');
  });

  it('full mode reprocesses a document once when its stored coverage predates content hashing', async () => {
    // No contentHash on the seeded coverage: a legacy record. No signal means
    // "assume changed" -- the whole document reprocesses once, and a hash is
    // stamped afterward so the *next* build can trust it (see the following test).
    const existing = emptyDocGraph();
    existing.corpusRevision = 2;
    existing.docCoverage = {
      a: { totalWindows: 3, selectedWindows: [0], completedWindows: [0], failedWindows: [] },
    };
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 2 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: longDoc('a', 3) });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(complete).toHaveBeenCalledTimes(3);
    expect(result.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2]);
    expect(result.graph?.docCoverage?.a.selectedWindows).toEqual([0, 1, 2]);
    expect(result.graph?.docCoverage?.a.contentHash).toBeDefined();
    expect(result.graph?.coverageMode).toBe('full');
    expect(result.graph?.processedDocIds).toEqual(['a']);
  });

  it('full mode resumes coverage with a matching content hash and only processes remaining windows', async () => {
    const chunks = longDoc('a', 3);
    const contentHash = shortHash(chunks.map((c) => c.text).join('\n'));
    const existing = emptyDocGraph();
    existing.corpusRevision = 2;
    existing.docCoverage = {
      a: { totalWindows: 3, selectedWindows: [0], completedWindows: [0], failedWindows: [], contentHash },
    };
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 2 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(complete).toHaveBeenCalledTimes(2); // only the 2 remaining windows; window 0 was already completed
    expect(result.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2]);
    expect(result.graph?.docCoverage?.a.selectedWindows).toEqual([0, 1, 2]);
    expect(result.graph?.coverageMode).toBe('full');
    expect(result.graph?.processedDocIds).toEqual(['a']);
  });

  it('does not re-attempt a document whose content hash matches stored coverage (cache hit)', async () => {
    const chunks = longDoc('a', 3);
    const contentHash = shortHash(chunks.map((c) => c.text).join('\n'));
    const existing = emptyDocGraph();
    existing.corpusRevision = 1;
    existing.docCoverage = {
      a: { totalWindows: 3, selectedWindows: [0, 1, 2], completedWindows: [0, 1, 2], failedWindows: [], contentHash },
    };
    existing.processedDocIds = ['a'];
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(complete).not.toHaveBeenCalled();
    expect(result.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2]);
    expect(result.graph?.processedDocIds).toEqual(['a']);
  });

  it('reprocesses a document when its content actually changed since the last build (cache miss)', async () => {
    const chunks = longDoc('a', 3);
    const existing = emptyDocGraph();
    existing.corpusRevision = 1;
    existing.docCoverage = {
      a: { totalWindows: 3, selectedWindows: [0, 1, 2], completedWindows: [0, 1, 2], failedWindows: [], contentHash: 'ffffff' },
    };
    existing.processedDocIds = ['a'];
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(complete).toHaveBeenCalledTimes(3);
    expect(result.graph?.docCoverage?.a.contentHash).toBe(shortHash(chunks.map((c) => c.text).join('\n')));
    expect(result.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2]);
    expect(result.graph?.processedDocIds).toEqual(['a']);
  });

  it('quick mode does not forget a window that failed outside its sample in a prior full-mode attempt', async () => {
    const chunks = longDoc('a', 8);
    const contentHash = shortHash(chunks.map((c) => c.text).join('\n'));
    const existing = emptyDocGraph();
    existing.corpusRevision = 1;
    existing.docCoverage = {
      a: {
        totalWindows: 8,
        selectedWindows: [0, 1, 2, 3, 4, 5, 6, 7],
        completedWindows: [0, 1, 2, 3, 4, 6, 7],
        failedWindows: [5],
        contentHash,
      },
    };
    existing.failedDocIds = ['a'];
    existing.docErrors = { a: 'Window 6/8: the model did not return valid JSON' };
    // coverageMode intentionally left unset: this doc was targeted under full
    // mode, but the corpus never fully completed (window 5 failed), so
    // coverageMode never flipped to 'full'.
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });

    const quickResult = await buildRepoGraph(S, 'repo', { mode: 'quick' });

    // Quick's own sample for an 8-window doc is evenlySpacedIndices(8, 6) = [0,1,3,4,6,7] -- excludes 5.
    expect(complete).not.toHaveBeenCalled();
    expect(quickResult.graph?.docCoverage?.a.selectedWindows).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 7 of the doc's 8 selected windows already completed (only window 5,
    // never in quick's own sample, is still outstanding) -- reported as
    // processed-with-a-warning, not a hard failure, since most of the
    // document's data is genuinely in the graph. Window 5 is still tracked as
    // outstanding via docCoverage (verified below), so a later full build
    // still retries it regardless of this reporting status.
    expect(quickResult.graph?.failedDocIds ?? []).not.toContain('a');
    expect(quickResult.graph?.processedDocIds).toContain('a');
    expect(quickResult.warnings?.some((w) => w.includes('A.md') && w.includes('1 of 8'))).toBe(true);

    // A subsequent full-mode build does retry window 5, and completing it processes the doc.
    graphGetRaw.mockResolvedValue({ ok: true, result: quickResult.graph });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const fullResult = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(fullResult.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(fullResult.graph?.processedDocIds).toEqual(['a']);
  });

  it('does not fail a document when one window has nothing to extract but the others succeed', async () => {
    // Regression test: a window returning valid, complete JSON with zero
    // entities/relations (extractOneDoc's 'empty' outcome) is not a failure —
    // it used to be bookkept identically to a truncated/unparseable response,
    // which meant one legitimately boilerplate window (e.g. a references or
    // qualification-table section) dragged an otherwise fully-extracted
    // document into failedDocIds.
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: longDoc('a', 3) });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      if (id === 'a:c1:s0') return { content: '{"entities":[],"relations":[]}' };
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(result.ok).toBe(true);
    expect(result.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2]);
    expect(result.graph?.docCoverage?.a.failedWindows).toEqual([]);
    expect(result.graph?.processedDocIds).toEqual(['a']);
    expect(result.graph?.failedDocIds ?? []).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('could not be extracted'))).not.toBe(true);
  });

  it('stops without marking partial coverage failed and can resume from its checkpoint', async () => {
    const controller = new AbortController();
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 3 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: longDoc('a', 3) });
    graphSet.mockResolvedValue({ ok: true });
    complete
      .mockResolvedValueOnce({
        content: '{"entities":[{"label":"first","type":"fact","summary":"first","evidence":["a:c0:s0"]}],"relations":[]}',
      })
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException('Stopped', 'AbortError'));
        throw controller.signal.reason;
      });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full', signal: controller.signal });

    expect(result.ok).toBe(true);
    expect(result.warnings?.[0]).toContain('stopped');
    expect(result.graph?.docCoverage?.a.completedWindows).toEqual([0]);
    expect(result.graph?.docCoverage?.a.failedWindows).toEqual([]);
    expect(result.graph?.processedDocIds).toEqual([]);
    expect(result.graph?.failedDocIds).toBeUndefined();
  });

  it('processes windows with bounded concurrency (never more than EXTRACTION_CONCURRENCY in flight)', async () => {
    const doc = longDoc('a', 10); // 10 windows on one document -> 3 batches at concurrency 4 (4+4+2)
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: doc });
    graphSet.mockResolvedValue({ ok: true });

    let inFlight = 0;
    let maxInFlight = 0;
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); // yield one microtask so sibling calls in the same batch can start first
      inFlight--;
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBe(4); // matches EXTRACTION_CONCURRENCY, and this doc alone proves it — no cross-document round-robin needed
  });

  it('checkpoints once per concurrent batch rather than once per window', async () => {
    const doc = longDoc('a', 10); // 10 windows -> ceil(10/4) = 3 extraction-batch checkpoints, not 10
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: doc });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(graphSet.mock.calls.length).toBeLessThan(10); // well under one checkpoint per window
  });

  it('skips a low-information window without a model call, never skipping the first/last targeted window', async () => {
    const dotRun = '.'.repeat(12100);
    const prose = (n: number) =>
      `Window ${n}: Shared Services Canada partnered with Microsoft Azure to modernize the department's infrastructure. `.repeat(150);
    const chunks = [
      { text: prose(0), sentences: [{ id: 'a:c0:s0', start: 0, end: prose(0).length }] },
      { text: dotRun, sentences: [{ id: 'a:c1:s0', start: 0, end: dotRun.length }] },
      { text: prose(2), sentences: [{ id: 'a:c2:s0', start: 0, end: prose(2).length }] },
    ];
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2); // windows 0 and 2 only; the dot-leader window 1 is skipped
    const calledIds = complete.mock.calls.map((call) => (call[1][1].content as string).match(/^\[\[([^\]]+)\]\]/)?.[1]);
    expect(calledIds).toEqual(['a:c0:s0', 'a:c2:s0']);
    expect(result.graph?.docCoverage?.a.skippedWindows).toEqual([1]);
    expect(result.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2]);
    expect(result.warnings?.some((w) => w.includes('skipped as low-information'))).toBe(true);
  });

  it('recovers a truncated window via adaptive split-retry, keeping the document fully processed instead of failed', async () => {
    // A single multi-sentence window (small enough to fit in one budget) so
    // there's something to split on truncation, unlike longDoc's one-sentence
    // windows.
    const text = 'Alice met Bob. Carol met Dave.';
    const chunks = [
      { text, sentences: [{ id: 'a:c0:s0', start: 0, end: 14 }, { id: 'a:c0:s1', start: 15, end: 30 }] },
    ];
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    let call = 0;
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      call++;
      if (call === 1) return { content: '{"entities":[{"label":"X"' }; // whole (2-sentence) window truncates
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(3); // 1 failed whole-window attempt + 2 single-sentence half retries
    expect(result.graph?.processedDocIds).toEqual(['a']);
    expect(result.graph?.failedDocIds ?? []).toEqual([]);
    expect(result.graph?.nodes.map((n) => n.label).sort()).toEqual(['a:c0:s0', 'a:c0:s1']);
  });

  it('runs a gleaning follow-up per window end-to-end when graphGleaningEnabled is on, adding what the first pass missed', async () => {
    const chunks = longDoc('a', 1); // one window
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    let call = 0;
    complete.mockImplementation(async () => {
      call++;
      if (call === 1) return { content: '{"entities":[{"label":"First","type":"fact","summary":"s","evidence":["a:c0:s0"]}],"relations":[]}' };
      return { content: '{"entities":[{"label":"Missed","type":"fact","summary":"s","evidence":["a:c0:s0"]}],"relations":[]}' };
    });

    const result = await buildRepoGraph({ ...S, graphGleaningEnabled: true } as Settings, 'repo', { mode: 'full' });

    expect(complete).toHaveBeenCalledTimes(2); // first pass + gleaning follow-up
    expect(result.graph?.nodes.map((n) => n.label).sort()).toEqual(['First', 'Missed']);
  });

  it('marks a document processed-with-a-warning (not failed) when one window still fails even after adaptive retry, as long as another window succeeded', async () => {
    // Each window here is a single sentence (longDoc), which can't be split
    // further -- this is exactly the "dense trailing section" shape from the
    // real bug report: the model degrades on a specific window regardless of
    // size, while every other window in the document is fine.
    const chunks = longDoc('a', 2);
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 1 } });
    graphGetRaw.mockResolvedValue({ ok: true, result: null });
    docChunks.mockResolvedValue({ ok: true, result: chunks });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      if (id === 'a:c1:s0') return { content: '{"entities":[{"label":"X"' }; // always truncated
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(result.ok).toBe(true);
    expect(result.graph?.processedDocIds).toEqual(['a']);
    expect(result.graph?.failedDocIds ?? []).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('A.md') && w.includes('1 of 2'))).toBe(true);
    expect(result.graph?.nodes.map((n) => n.label)).toEqual(['a:c0:s0']); // the recoverable window's data made it in
  });
});
