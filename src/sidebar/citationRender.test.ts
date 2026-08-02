// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { injectCitationChips } from '../shared/citations';

marked.setOptions({ gfm: true, breaks: true });

function render(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

describe('citation chip rendering over real markdown', () => {
  it('preserves [[id]] tokens through marked + DOMPurify', () => {
    const html = render('Model selection is at the app level [[doc-73:c42:s4#8f31ca]].');
    expect(html).toContain('[[doc-73:c42:s4#8f31ca]]');
  });

  it('injects numbered chips for known ids and drops unknown ones', () => {
    const html = render(
      'A fact [[doc-1:c0:s0#aaa111]] and a bogus one [[doc-9:c9:s9#zzz999]] in a - list item.',
    );
    const chips = injectCitationChips(html, new Map([['doc-1:c0:s0#aaa111', 1]]));
    expect(chips).toContain('data-cite-id="doc-1:c0:s0#aaa111"');
    expect(chips).toContain('>1</sup>');
    expect(chips).not.toContain('zzz999');
    expect(chips).not.toContain('[[');
  });
});
