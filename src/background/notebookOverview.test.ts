import { afterEach, describe, expect, it, vi } from 'vitest';

const complete = vi.fn();
vi.mock('./llmProvider', () => ({
  complete: (...a: unknown[]) => complete(...a),
  resolveModelForRole: (s: unknown) => s,
}));
const notebookSample = vi.fn();
const notebookSet = vi.fn();
vi.mock('./offscreenClient', () => ({
  notebookSample: (...a: unknown[]) => notebookSample(...a),
  notebookSet: (...a: unknown[]) => notebookSet(...a),
}));

import { buildOverviewPrompt, generateNotebookOverview, isOverviewStale, parseOverview } from './notebookOverview';
import type { NotebookOverview, Settings } from '../shared/types';

afterEach(() => {
  complete.mockReset();
  notebookSample.mockReset();
  notebookSet.mockReset();
});

describe('buildOverviewPrompt', () => {
  it('lists docs and includes budgeted sample passages', () => {
    const prompt = buildOverviewPrompt({
      docs: [{ id: 'd1', name: 'a.txt' }, { id: 'd2', name: 'b.txt' }],
      chunkCount: 2,
      samples: [
        { docId: 'd1', name: 'a.txt', text: 'Arctic shipping lanes are opening.' },
        { docId: 'd2', name: 'b.txt', text: 'Vendors include ACME and Globex.' },
      ],
    });
    expect(prompt).toContain('Documents (2):');
    expect(prompt).toContain('- a.txt');
    expect(prompt).toContain('[a.txt] Arctic shipping lanes are opening.');
    expect(prompt).toContain('[b.txt] Vendors include ACME and Globex.');
  });

  it('skips blank passages', () => {
    const prompt = buildOverviewPrompt({
      docs: [{ id: 'd1', name: 'a.txt' }],
      chunkCount: 1,
      samples: [{ docId: 'd1', name: 'a.txt', text: '   ' }],
    });
    expect(prompt).not.toContain('[a.txt]');
  });
});

describe('parseOverview', () => {
  it('parses a well-formed reply', () => {
    const out = parseOverview('{"overview":"## X\\ntext","keyTopics":["a","b"],"suggestedQuestions":["Q1?"]}');
    expect(out).toEqual({ overviewMarkdown: '## X\ntext', keyTopics: ['a', 'b'], suggestedQuestions: ['Q1?'] });
  });

  it('tolerates code fences and prose around the JSON', () => {
    const out = parseOverview('Here you go:\n```json\n{"overview":"o","keyTopics":[],"suggestedQuestions":["Q?"]}\n```');
    expect(out?.overviewMarkdown).toBe('o');
    expect(out?.suggestedQuestions).toEqual(['Q?']);
  });

  it('drops non-string / blank list items', () => {
    const out = parseOverview('{"overview":"o","keyTopics":["a",2,"  ",""],"suggestedQuestions":[]}');
    expect(out?.keyTopics).toEqual(['a']);
  });

  it('returns null for empty/garbage', () => {
    expect(parseOverview('not json')).toBeNull();
    expect(parseOverview('{"overview":"","keyTopics":[],"suggestedQuestions":[]}')).toBeNull();
  });
});

describe('isOverviewStale', () => {
  const base: NotebookOverview = {
    overviewMarkdown: 'o',
    keyTopics: [],
    suggestedQuestions: [],
    docCount: 3,
    chunkCount: 20,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  it('is stale when missing', () => expect(isOverviewStale(null, 3, 20)).toBe(true));
  it('is fresh when counts match', () => expect(isOverviewStale(base, 3, 20)).toBe(false));
  it('is stale when a doc or chunk count changed', () => {
    expect(isOverviewStale(base, 4, 20)).toBe(true);
    expect(isOverviewStale(base, 3, 25)).toBe(true);
  });
});

describe('generateNotebookOverview prompt resolution', () => {
  const sample = {
    docs: [{ id: 'd1', name: 'a.txt' }],
    chunkCount: 1,
    samples: [{ docId: 'd1', name: 'a.txt', text: 'Some content.' }],
  };
  const reply = { content: '{"overview":"o","keyTopics":["t"],"suggestedQuestions":["q?"]}' };

  it('uses a promptOverrides.notebookOverview override for the system message, when set', async () => {
    notebookSample.mockResolvedValue({ ok: true, result: sample });
    notebookSet.mockResolvedValue({ ok: true });
    complete.mockResolvedValue(reply);
    const settings = { promptOverrides: { notebookOverview: 'CUSTOM NOTEBOOK PROMPT' } } as Settings;
    await generateNotebookOverview(settings, 'repo');
    const messages = complete.mock.calls.at(-1)?.[1];
    expect(messages[0]).toEqual({ role: 'system', content: 'CUSTOM NOTEBOOK PROMPT' });
  });

  it('falls back to the built-in default system message with no override', async () => {
    notebookSample.mockResolvedValue({ ok: true, result: sample });
    notebookSet.mockResolvedValue({ ok: true });
    complete.mockResolvedValue(reply);
    await generateNotebookOverview({} as Settings, 'repo');
    const messages = complete.mock.calls.at(-1)?.[1];
    expect(messages[0].content).toContain('creating a "notebook" overview');
  });
});
