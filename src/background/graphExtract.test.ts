import { afterEach, describe, expect, it, vi } from 'vitest';

// complete() is the only model touchpoint; mock it so extraction is deterministic.
const complete = vi.fn();
vi.mock('./llmProvider', () => ({
  complete: (...a: unknown[]) => complete(...a),
  resolveModelForRole: (s: unknown) => s,
}));

import { extractOneDoc, looksTruncated, summarizeCommunities, tagDocChunks, windowDocChunks } from './graphExtract';
import { emptyDocGraph, mergeExtraction } from '../shared/docGraph';
import type { Settings } from '../shared/types';

afterEach(() => complete.mockReset());

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

  it('caps at maxWindows, dropping the remainder', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, start: 0, end: 5 }));
    const text = 'x'.repeat(50);
    const windows = windowDocChunks(
      sentences.map((s) => ({ text, sentences: [s] })),
      1, // each sentence alone exceeds this budget, forcing a new window every time
      3,
    );
    expect(windows.length).toBeLessThanOrEqual(3);
  });

  it('returns a single empty window for no input', () => {
    expect(windowDocChunks([])).toEqual([{ text: '', validIds: new Set() }]);
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
});
