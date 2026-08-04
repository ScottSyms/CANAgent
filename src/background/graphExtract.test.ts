import { afterEach, describe, expect, it, vi } from 'vitest';

// complete() is the only model touchpoint; mock it so extraction is deterministic.
const complete = vi.fn();
const resolveModelForRole = vi.fn((settings: unknown, _role: unknown) => settings);
vi.mock('./llmProvider', () => ({
  complete: (...a: unknown[]) => complete(...a),
  resolveModelForRole: (settings: unknown, role: unknown) => resolveModelForRole(settings, role),
}));
const graphSnapshot = vi.fn();
const graphGet = vi.fn();
const graphSet = vi.fn();
const docChunks = vi.fn();
vi.mock('./offscreenClient', () => ({
  graphSnapshot: (...a: unknown[]) => graphSnapshot(...a),
  graphGet: (...a: unknown[]) => graphGet(...a),
  graphSet: (...a: unknown[]) => graphSet(...a),
  docChunks: (...a: unknown[]) => docChunks(...a),
}));

import {
  buildRepoGraph,
  evenlySpacedIndices,
  extractOneDoc,
  looksTruncated,
  summarizeCommunities,
  tagDocChunks,
  windowDocChunks,
} from './graphExtract';
import { emptyDocGraph, mergeExtraction } from '../shared/docGraph';
import type { Settings } from '../shared/types';

afterEach(() => {
  complete.mockReset();
  resolveModelForRole.mockClear();
  graphSnapshot.mockReset();
  graphGet.mockReset();
  graphSet.mockReset();
  docChunks.mockReset();
});

const S = {} as Settings;

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

describe('evenlySpacedIndices', () => {
  it('includes both ends and deterministic interior positions', () => {
    expect(evenlySpacedIndices(10, 3)).toEqual([0, 5, 9]);
    expect(evenlySpacedIndices(4, 6)).toEqual([0, 1, 2, 3]);
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
    }
  });

  it('reports a parse_error when the model returns non-JSON prose', async () => {
    complete.mockResolvedValue({ content: 'sorry, I cannot' });
    expect(await extractOneDoc(S, 'x', new Set())).toEqual({ ok: false, reason: 'parse_error' });
  });

  it('reports truncated when the JSON is cut off mid-object', async () => {
    complete.mockResolvedValue({ content: '{"entities":[{"label":"X","evidence":["a"' });
    expect(await extractOneDoc(S, 'x', new Set(['a']))).toEqual({ ok: false, reason: 'truncated' });
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

describe('buildRepoGraph corpus revision', () => {
  it('rejects a checkpoint when the repository changes during extraction', async () => {
    graphSnapshot.mockResolvedValue({
      ok: true,
      result: { docs: [{ id: 'doc-1', name: 'a.md' }], corpusRevision: 4 },
    });
    graphGet.mockResolvedValue({ ok: true, result: null });
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

  it('quick mode samples every document from beginning to end and interleaves model calls', async () => {
    graphSnapshot.mockResolvedValue({
      ok: true,
      result: { docs: [{ id: 'b', name: 'B.md' }, { id: 'a', name: 'A.md' }], corpusRevision: 1 },
    });
    graphGet.mockResolvedValue({ ok: true, result: null });
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
    const extractionInputs = complete.mock.calls.map((call) => call[1][1].content as string);
    expect(extractionInputs[0]).toContain('[[a:c0:s0]]');
    expect(extractionInputs[1]).toContain('[[b:c0:s0]]');
    expect(extractionInputs).toContainEqual(expect.stringContaining('[[a:c7:s0]]'));
    expect(extractionInputs).toContainEqual(expect.stringContaining('[[b:c7:s0]]'));
    expect(result.warnings?.join(' ')).toContain('Full Coverage');
  });

  it('full mode resumes legacy/partial coverage and processes every remaining window', async () => {
    const existing = emptyDocGraph();
    existing.corpusRevision = 2;
    existing.docCoverage = {
      a: { totalWindows: 3, selectedWindows: [0], completedWindows: [0], failedWindows: [] },
    };
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 2 } });
    graphGet.mockResolvedValue({ ok: true, result: existing });
    docChunks.mockResolvedValue({ ok: true, result: longDoc('a', 3) });
    graphSet.mockResolvedValue({ ok: true });
    complete.mockImplementation(async (_settings: unknown, messages: Array<{ content: string }>) => {
      const id = messages[1].content.match(/^\[\[([^\]]+)\]\]/)?.[1] ?? 'missing';
      return { content: JSON.stringify({ entities: [{ label: id, type: 'fact', summary: id, evidence: [id] }], relations: [] }) };
    });

    const result = await buildRepoGraph(S, 'repo', { mode: 'full' });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.graph?.docCoverage?.a.completedWindows.sort()).toEqual([0, 1, 2]);
    expect(result.graph?.docCoverage?.a.selectedWindows).toEqual([0, 1, 2]);
    expect(result.graph?.coverageMode).toBe('full');
    expect(result.graph?.processedDocIds).toEqual(['a']);
  });

  it('stops without marking partial coverage failed and can resume from its checkpoint', async () => {
    const controller = new AbortController();
    graphSnapshot.mockResolvedValue({ ok: true, result: { docs: [{ id: 'a', name: 'A.md' }], corpusRevision: 3 } });
    graphGet.mockResolvedValue({ ok: true, result: null });
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
});
