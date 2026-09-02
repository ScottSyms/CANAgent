import { describe, expect, it } from 'vitest';
import manifest from '../../public/manifest.json';

describe('extension manifest security baseline', () => {
  it('uses an MV3 module service worker without external messaging', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'serviceWorker.js', type: 'module' });
    expect(manifest).not.toHaveProperty('externally_connectable');
  });

  it('grants identity and native messaging only to extension code', () => {
    expect(manifest.permissions).toContain('identity');
    expect(manifest.permissions).toContain('nativeMessaging');
    expect(manifest.content_scripts.every((script) => !script.js.some((file) => /provider|oauth|token/i.test(file)))).toBe(true);
  });

  it('does not relax extension CSP for remote scripts', () => {
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    expect(manifest.content_security_policy.extension_pages).not.toMatch(/https?:/);
  });
});
