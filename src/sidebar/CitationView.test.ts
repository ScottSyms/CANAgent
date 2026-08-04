// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '../shared/types';
import { CitationView } from './CitationView';

function citation(sentenceId: string): Citation {
  const sentenceText = 'The supported sentence.';
  const chunkText = `${'Earlier context. '.repeat(100)}${sentenceText}${' Later context.'.repeat(100)}`;
  const start = chunkText.indexOf(sentenceText);
  return {
    sentenceId,
    docName: 'Long article',
    url: 'https://example.com/article',
    sentenceText,
    chunkText,
    start,
    end: start + sentenceText.length,
  };
}

describe('CitationView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('centers the highlighted sentence when opened and when the citation changes', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains('citation-view-mark') ? 700 : 100;
      const height = this.classList.contains('citation-view-mark') ? 20 : 400;
      return { top, bottom: top + height, left: 0, right: 320, width: 320, height, x: 0, y: top, toJSON: () => ({}) };
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('citation-view') ? 400 : 20;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('citation-view') ? 2000 : 20;
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    act(() => render(h(CitationView, { citation: citation('first:c0:s0#aaaaaa'), onClose: () => {} }), root));
    const view = root.querySelector<HTMLElement>('.citation-view');
    expect(view?.scrollTop).toBe(410);

    if (view) view.scrollTop = 0;
    act(() => render(h(CitationView, { citation: citation('second:c0:s0#bbbbbb'), onClose: () => {} }), root));
    expect(view?.scrollTop).toBe(410);
  });
});
