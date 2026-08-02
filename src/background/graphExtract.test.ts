import { afterEach, describe, expect, it, vi } from 'vitest';

// complete() is the only model touchpoint; mock it so extraction is deterministic.
const complete = vi.fn();
vi.mock('./llmProvider', () => ({
  complete: (...a: unknown[]) => complete(...a),
  resolveModelForRole: (s: unknown) => s,
}));

import { extractOneDoc, summarizeCommunities, tagDocChunks } from './graphExtract';
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

describe('extractOneDoc', () => {
  it('parses the model JSON and keeps only in-document evidence ids', async () => {
    complete.mockResolvedValue({
      content:
        '{"entities":[{"label":"SSC","type":"org","summary":"s","evidence":["d:c0:s0#a","fabricated"]}],' +
        '"relations":[{"from":"SSC","to":"Azure","relation":"uses","evidence":["d:c0:s1#b"]}]}',
    });
    const out = await extractOneDoc(S, '[[d:c0:s0#a]] ...', new Set(['d:c0:s0#a', 'd:c0:s1#b']));
    expect(out.entities[0].evidence).toEqual(['d:c0:s0#a']); // fabricated dropped
    expect(out.relations[0]).toMatchObject({ from: 'SSC', to: 'Azure', relation: 'uses' });
  });

  it('returns empty extraction when the model returns non-JSON', async () => {
    complete.mockResolvedValue({ content: 'sorry, I cannot' });
    expect(await extractOneDoc(S, 'x', new Set())).toEqual({ entities: [], relations: [] });
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
