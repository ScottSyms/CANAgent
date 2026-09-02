import { describe, expect, it } from 'vitest';
import { isTrustedExtensionSender } from './messageValidation';

describe('provider message isolation', () => {
  const root = 'chrome-extension://extension-id/';

  it('allows extension pages', () => {
    expect(isTrustedExtensionSender({ url: `${root}workspace.html` }, root)).toBe(true);
  });

  it('rejects content scripts and absent sender URLs', () => {
    expect(isTrustedExtensionSender({ url: 'https://example.com/page' }, root)).toBe(false);
    expect(isTrustedExtensionSender({ tab: { url: 'https://example.com/page' } }, root)).toBe(false);
    expect(isTrustedExtensionSender({}, root)).toBe(false);
  });
});
