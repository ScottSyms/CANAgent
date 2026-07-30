import { describe, expect, it } from 'vitest';
import { redactArgs, sha256Hex } from './audit';

describe('sha256Hex', () => {
  it('is stable and 64 hex chars', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });

  it('matches the known SHA-256 of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('redactArgs', () => {
  it('masks sensitive-looking keys', () => {
    const out = redactArgs({ password: 'hunter2', apiKey: 'sk-123', authorization: 'Bearer x', cookie: 'c' });
    expect(out).toEqual({ password: '[redacted]', apiKey: '[redacted]', authorization: '[redacted]', cookie: '[redacted]' });
  });

  it('truncates long strings but keeps short ones', () => {
    const long = 'x'.repeat(500);
    const out = redactArgs({ note: long, tabId: 3, short: 'ok' });
    expect((out.note as string).endsWith('…')).toBe(true);
    expect((out.note as string).length).toBeLessThan(long.length);
    expect(out.tabId).toBe(3);
    expect(out.short).toBe('ok');
  });

  it('does not carry a raw secret value through', () => {
    const out = redactArgs({ api_key: 'super-secret-value' });
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
  });
});
