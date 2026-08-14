import { afterEach, describe, expect, it, vi } from 'vitest';

const complete = vi.fn();
vi.mock('./llmProvider', () => ({
  complete: (...a: unknown[]) => complete(...a),
  resolveModelForRole: (s: unknown) => s,
}));
const graphGet = vi.fn();
const studioGet = vi.fn();
const studioSet = vi.fn();
vi.mock('./offscreenClient', () => ({
  graphGet: (...a: unknown[]) => graphGet(...a),
  studioGet: (...a: unknown[]) => studioGet(...a),
  studioSet: (...a: unknown[]) => studioSet(...a),
}));
const resolveSentenceCitations = vi.fn();
vi.mock('./sentenceResolve', () => ({
  resolveSentenceCitations: (...a: unknown[]) => resolveSentenceCitations(...a),
}));

import { buildStudioContext, cleanCitations, generateStudioOutput } from './studioOutputs';
import { emptyDocGraph, mergeExtraction } from '../shared/docGraph';
import type { Settings } from '../shared/types';

afterEach(() => {
  complete.mockReset();
  graphGet.mockReset();
  studioGet.mockReset();
  studioSet.mockReset();
  resolveSentenceCitations.mockReset();
});

describe('buildStudioContext', () => {
  it('includes themes (when present) and top entities, all sentence-tagged', () => {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [{ label: 'SSC', type: 'org', summary: 'Runs IT.', evidence: ['s1'] }],
        relations: [{ from: 'SSC', to: 'Azure', relation: 'uses', evidence: ['s2'] }],
      },
      'doc-1',
    );
    g.communities = [{ id: 'com0', title: 'Cloud', summary: 'About cloud.', nodeIds: [], evidenceSentenceIds: ['s3'] }];

    const ctx = buildStudioContext(g);
    expect(ctx).toContain('Themes:');
    expect(ctx).toContain('## Cloud');
    expect(ctx).toContain('SSC —uses→ Azure');
    expect(ctx).toContain('[[s2]]');
  });

  it('works with no communities (entities only)', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'A', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'd');
    const ctx = buildStudioContext(g);
    expect(ctx).not.toContain('Themes:');
    expect(ctx).toContain('A (x)');
  });
});

describe('cleanCitations', () => {
  it('keeps resolved ids and strips unresolved ones', () => {
    const md = 'Fact one [[doc:c0:s0#a]] and a bad one [[doc:c9:s9#z]].';
    expect(cleanCitations(md, new Set(['doc:c0:s0#a']))).toBe('Fact one [[doc:c0:s0#a]] and a bad one .');
  });
});

describe('generateStudioOutput prompt resolution', () => {
  const g = emptyDocGraph();
  mergeExtraction(g, { entities: [{ label: 'A', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'd');

  it('uses a promptOverrides.studioFaq override for the system message, with the shared tail always appended', async () => {
    graphGet.mockResolvedValue({ ok: true, result: g });
    complete.mockResolvedValue({ content: 'Some FAQ markdown.' });
    resolveSentenceCitations.mockResolvedValue([]);
    studioGet.mockResolvedValue({ ok: true, result: { outputs: {} } });
    studioSet.mockResolvedValue({ ok: true });
    const settings = { promptOverrides: { studioFaq: 'CUSTOM FAQ PROMPT.' } } as Settings;
    await generateStudioOutput(settings, 'repo', 'faq');
    const messages = complete.mock.calls.at(-1)?.[1];
    expect(messages[0].content.startsWith('CUSTOM FAQ PROMPT.')).toBe(true);
    // The grounding/citation tail is force-appended regardless of the override.
    expect(messages[0].content).toContain('Do not invent ids or facts.');
  });

  it('falls back to the built-in default system message with no override', async () => {
    graphGet.mockResolvedValue({ ok: true, result: g });
    complete.mockResolvedValue({ content: 'Some briefing markdown.' });
    resolveSentenceCitations.mockResolvedValue([]);
    studioGet.mockResolvedValue({ ok: true, result: { outputs: {} } });
    studioSet.mockResolvedValue({ ok: true });
    await generateStudioOutput({} as Settings, 'repo', 'briefing');
    const messages = complete.mock.calls.at(-1)?.[1];
    expect(messages[0].content).toContain('You write a concise briefing document');
  });

  it('saves against the source graph revision and reports a concurrent mutation', async () => {
    graphGet.mockResolvedValue({ ok: true, result: { ...g, corpusRevision: 7 } });
    complete.mockResolvedValue({ content: 'Some briefing markdown.' });
    resolveSentenceCitations.mockResolvedValue([]);
    studioGet.mockResolvedValue({ ok: true, result: { outputs: {} } });
    studioSet.mockResolvedValue({ ok: false, error: 'Repository changed while the Studio output was being generated.' });

    const result = await generateStudioOutput({} as Settings, 'repo', 'briefing');

    expect(studioSet).toHaveBeenCalledWith('repo', expect.any(Object), 7);
    expect(result).toEqual({ ok: false, error: 'Repository changed while the Studio output was being generated.' });
  });
});
