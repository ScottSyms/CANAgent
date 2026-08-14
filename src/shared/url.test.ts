import { describe, expect, it } from 'vitest';
import { collectGroupUrls, documentKindForUrl, hostMatches, normalizeHost, resolveOfficeUrl, resolvePdfUrl } from './url';

describe('collectGroupUrls', () => {
  it('keeps http(s) tabs and carries titles', () => {
    expect(
      collectGroupUrls([
        { url: 'https://a.com/', title: 'A' },
        { url: 'http://b.com/', title: 'B' },
      ]),
    ).toEqual([
      { url: 'https://a.com/', title: 'A' },
      { url: 'http://b.com/', title: 'B' },
    ]);
  });

  it('drops non-http and empty URLs, defaults missing titles', () => {
    expect(
      collectGroupUrls([
        { url: 'chrome://extensions' },
        { url: 'about:blank' },
        { url: '' },
        { url: 'https://ok.com/' },
      ]),
    ).toEqual([{ url: 'https://ok.com/', title: '' }]);
  });

  it('dedupes by URL and caps the count', () => {
    const dup = collectGroupUrls([
      { url: 'https://x.com/', title: '1' },
      { url: 'https://x.com/', title: '2' },
    ]);
    expect(dup).toEqual([{ url: 'https://x.com/', title: '1' }]);

    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://x.com/${i}`, title: '' }));
    expect(collectGroupUrls(many, 16)).toHaveLength(16);
  });
});

describe('normalizeHost', () => {
  it('strips scheme, path, query, hash, and www', () => {
    expect(normalizeHost('https://www.Example.com/path?q=1#h')).toBe('example.com');
  });
  it('handles a bare host', () => {
    expect(normalizeHost('Example.COM')).toBe('example.com');
  });
  it('keeps non-www subdomains', () => {
    expect(normalizeHost('https://mail.google.com/')).toBe('mail.google.com');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeHost('  example.com  ')).toBe('example.com');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeHost('')).toBe('');
  });
});

describe('hostMatches', () => {
  it('matches identical hosts', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
  });
  it('matches a subdomain of the origin', () => {
    expect(hostMatches('mail.example.com', 'example.com')).toBe(true);
  });
  it('ignores www and scheme on either side', () => {
    expect(hostMatches('https://www.example.com', 'example.com')).toBe(true);
  });
  it('does not match a different domain', () => {
    expect(hostMatches('evil.com', 'example.com')).toBe(false);
  });
  it('does not match a suffix that is not a subdomain boundary', () => {
    // notexample.com must NOT match example.com
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
  });
  it('returns false when either side is empty', () => {
    expect(hostMatches('', 'example.com')).toBe(false);
    expect(hostMatches('example.com', '')).toBe(false);
  });
});

describe('documentKindForUrl', () => {
  it('classifies Office files by extension', () => {
    expect(documentKindForUrl('https://x.sharepoint.com/sites/T/Shared%20Documents/Report.docx')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Deck.pptx')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Budget.xlsx')).toBe('office');
  });

  it('ignores query strings on the extension test', () => {
    expect(documentKindForUrl('https://x.sharepoint.com/Report.pptx?web=1&csf=1')).toBe('office');
  });

  it('classifies the wider format set anydoc converts (OpenDocument, RTF, EPUB, PowerPoint slideshow)', () => {
    expect(documentKindForUrl('https://x.sharepoint.com/Notes.odt')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Sheet.ods')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Slides.odp')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Note.rtf')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Book.epub')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Deck.ppsx')).toBe('office');
  });

  it('classifies PDFs', () => {
    expect(documentKindForUrl('https://example.com/docs/manual.pdf')).toBe('pdf');
    expect(documentKindForUrl('https://example.com/docs/manual.pdf?download=1#page=2')).toBe('pdf');
  });

  it('unwraps Chrome PDF viewer URLs', () => {
    const pdf = 'https://example.com/docs/manual.pdf?download=1#page=2';
    const viewer = `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=${encodeURIComponent(pdf)}`;
    expect(resolvePdfUrl(viewer)).toBe(pdf);
    expect(documentKindForUrl(viewer)).toBe('pdf');
  });

  it('unwraps a SharePoint Office-Online viewer URL via resolveOfficeUrl', () => {
    const viewer =
      'https://contoso.sharepoint.com/sites/Finance/_layouts/15/Doc.aspx?sourcedoc=%7B12345678-1234-1234-1234-1234567890AB%7D&file=Report.docx&action=default';
    expect(resolveOfficeUrl(viewer)).toBe(
      "https://contoso.sharepoint.com/sites/Finance/_api/web/GetFileById('12345678-1234-1234-1234-1234567890AB')/$value",
    );
    expect(documentKindForUrl(viewer)).toBe('office');
  });

  it('unwraps the WopiFrame variant, incl. a OneDrive-for-Business personal site', () => {
    const viewer =
      'https://contoso-my.sharepoint.com/personal/jane_contoso_com/_layouts/15/WopiFrame.aspx?sourcedoc={abcdef12-abcd-abcd-abcd-abcdef123456}&file=Plan.xlsx';
    expect(resolveOfficeUrl(viewer)).toBe(
      "https://contoso-my.sharepoint.com/personal/jane_contoso_com/_api/web/GetFileById('abcdef12-abcd-abcd-abcd-abcdef123456')/$value",
    );
  });

  it('unwraps a SharePoint sharing link to the underlying file path', () => {
    const sharing =
      'https://contoso.sharepoint.com/:w:/r/sites/Finance/Shared%20Documents/Report.docx?d=w12345678123412341234567890abcdef&csf=1&web=1&e=Ab3xYz';
    expect(resolveOfficeUrl(sharing)).toBe(
      'https://contoso.sharepoint.com/sites/Finance/Shared%20Documents/Report.docx',
    );
    expect(documentKindForUrl(sharing)).toBe('office');
  });

  it('unwraps Excel and PowerPoint sharing links too', () => {
    expect(
      resolveOfficeUrl('https://contoso.sharepoint.com/:x:/r/sites/T/Docs/Budget.xlsx?web=1'),
    ).toBe('https://contoso.sharepoint.com/sites/T/Docs/Budget.xlsx');
    expect(
      resolveOfficeUrl('https://contoso-my.sharepoint.com/:p:/r/personal/jane_contoso_com/Documents/Deck.pptx?e=x'),
    ).toBe('https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents/Deck.pptx');
  });

  it('rejects an opaque sharing token with no file path', () => {
    expect(resolveOfficeUrl('https://contoso.sharepoint.com/:w:/s/Finance/EY3gabcdef')).toBeNull();
  });

  it('unwraps the new cloud.microsoft editor via its wopisrc param', () => {
    const wopi = encodeURIComponent(
      'https://contoso.sharepoint.com/sites/Finance/_vti_bin/wopi.ashx/files/12345678-1234-1234-1234-1234567890ab',
    );
    const viewer = `https://word.cloud.microsoft/we/wordeditorframe.aspx?ui=en-US&rs=en-US&wopisrc=${wopi}`;
    expect(resolveOfficeUrl(viewer)).toBe(
      "https://contoso.sharepoint.com/sites/Finance/_api/web/GetFileById('12345678-1234-1234-1234-1234567890ab')/$value",
    );
    expect(documentKindForUrl(viewer)).toBe('office');
  });

  it('accepts the WOPISrc casing variant and rejects a non-WOPI wopisrc', () => {
    const wopi = encodeURIComponent(
      'https://contoso-my.sharepoint.com/personal/jane_contoso_com/_vti_bin/wopi.ashx/files/abcdef12-abcd-abcd-abcd-abcdef123456',
    );
    expect(
      resolveOfficeUrl(`https://excel.cloud.microsoft/x/xlviewerinternal.aspx?WOPISrc=${wopi}`),
    ).toBe(
      "https://contoso-my.sharepoint.com/personal/jane_contoso_com/_api/web/GetFileById('abcdef12-abcd-abcd-abcd-abcdef123456')/$value",
    );
    expect(
      resolveOfficeUrl('https://word.cloud.microsoft/we/frame.aspx?wopisrc=https%3A%2F%2Fevil.com%2Fnot-wopi'),
    ).toBeNull();
  });

  it('returns the URL unchanged for a direct Office file URL', () => {
    const direct = 'https://contoso.sharepoint.com/sites/T/Shared%20Documents/Report.docx';
    expect(resolveOfficeUrl(direct)).toBe(direct);
  });

  it('rejects a Doc.aspx URL with no sourcedoc or a malformed GUID', () => {
    expect(
      resolveOfficeUrl('https://contoso.sharepoint.com/sites/Finance/_layouts/15/Doc.aspx?file=Report.docx'),
    ).toBeNull();
    expect(
      resolveOfficeUrl('https://contoso.sharepoint.com/sites/Finance/_layouts/15/Doc.aspx?sourcedoc=not-a-guid'),
    ).toBeNull();
  });

  it('returns null for normal web pages', () => {
    expect(documentKindForUrl('https://example.com/articles/intro')).toBeNull();
    expect(documentKindForUrl('https://example.com/Doc.aspx?sourcedoc=%7B123%7D')).toBeNull();
    expect(resolveOfficeUrl('https://example.com/Doc.aspx?sourcedoc=%7B123%7D')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(documentKindForUrl('not a url')).toBeNull();
  });
});
