import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPTS, pruneEmptyOverrides, resolvePrompt } from './promptDefaults';

describe('resolvePrompt', () => {
  it('falls back to the default when no override is set', () => {
    expect(resolvePrompt(undefined, 'notebookOverview')).toBe(DEFAULT_PROMPTS.notebookOverview);
    expect(resolvePrompt({}, 'graphExtraction')).toBe(DEFAULT_PROMPTS.graphExtraction);
  });

  it('uses the override when present and non-blank', () => {
    expect(resolvePrompt({ notebookOverview: 'custom prompt' }, 'notebookOverview')).toBe('custom prompt');
  });

  it('falls back to the default for a whitespace-only override', () => {
    expect(resolvePrompt({ notebookOverview: '   ' }, 'notebookOverview')).toBe(DEFAULT_PROMPTS.notebookOverview);
  });

  it('every PromptKey has a non-empty default', () => {
    for (const key of Object.keys(DEFAULT_PROMPTS) as (keyof typeof DEFAULT_PROMPTS)[]) {
      expect(DEFAULT_PROMPTS[key].trim().length).toBeGreaterThan(0);
    }
  });
});

describe('pruneEmptyOverrides', () => {
  it('drops blank/whitespace-only entries', () => {
    expect(pruneEmptyOverrides({ notebookOverview: '', graphExtraction: '  ', communitySummary: 'x' })).toEqual({
      communitySummary: 'x',
    });
  });

  it('collapses an all-empty result to undefined', () => {
    expect(pruneEmptyOverrides({ notebookOverview: '', graphExtraction: '  ' })).toBeUndefined();
    expect(pruneEmptyOverrides(undefined)).toBeUndefined();
    expect(pruneEmptyOverrides({})).toBeUndefined();
  });

  it('leaves well-formed overrides untouched', () => {
    expect(pruneEmptyOverrides({ studioFaq: 'x', studioBriefing: 'y' })).toEqual({ studioFaq: 'x', studioBriefing: 'y' });
  });
});
