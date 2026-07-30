import { describe, expect, it } from 'vitest';
import { buildResumePrompt, MAX_RECOVERY_ATTEMPTS, reconcileTabs, shouldAutoResume } from './recovery';

describe('shouldAutoResume', () => {
  it('resumes below the cap and stops at it', () => {
    expect(shouldAutoResume(0)).toBe(true);
    expect(shouldAutoResume(MAX_RECOVERY_ATTEMPTS - 1)).toBe(true);
    expect(shouldAutoResume(MAX_RECOVERY_ATTEMPTS)).toBe(false);
    expect(shouldAutoResume(MAX_RECOVERY_ATTEMPTS + 5)).toBe(false);
  });
});

describe('reconcileTabs', () => {
  const a = { url: 'https://example.gc.ca/a', title: 'A' };
  const b = { url: 'https://example.gc.ca/b', title: 'B' };

  it('reports nothing missing when all expected tabs are open', () => {
    const r = reconcileTabs([a, b], [a.url, b.url, 'https://other']);
    expect(r.missing).toHaveLength(0);
    expect(r.note).toBe('');
  });

  it('flags tabs that are no longer open, with title and url in the note', () => {
    const r = reconcileTabs([a, b], [a.url]);
    expect(r.missing).toEqual([b]);
    expect(r.note).toContain('B');
    expect(r.note).toContain(b.url);
  });

  it('ignores trailing-hash differences when matching', () => {
    const r = reconcileTabs([a], [`${a.url}#section-2`]);
    expect(r.missing).toHaveLength(0);
  });

  it('treats an empty expectation as nothing missing', () => {
    expect(reconcileTabs([], ['https://x']).note).toBe('');
  });
});

describe('buildResumePrompt', () => {
  it('carries the original task and forbids assuming writes completed', () => {
    const p = buildResumePrompt('Book me a flight to Ottawa', 4, '');
    expect(p).toContain('Book me a flight to Ottawa');
    expect(p).toContain('step 4');
    expect(p.toLowerCase()).toContain('do not assume');
    expect(p.toLowerCase()).toContain('request approval');
  });

  it('appends the reconciliation note when pages are missing', () => {
    const note = '1 page(s) this task had open are no longer available: "A" (https://x).';
    const p = buildResumePrompt('task', 2, note);
    expect(p).toContain(note);
  });

  it('omits the step number when nothing had run yet', () => {
    const p = buildResumePrompt('task', 0, '');
    expect(p).not.toContain('step 0');
  });
});
