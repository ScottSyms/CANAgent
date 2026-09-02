import { describe, expect, it } from 'vitest';
import { redact, redactedError, redactFields } from './redact';

describe('redact', () => {
  it('redacts a GitHub OAuth token', () => {
    expect(redact('token=gho_1234567890abcdef')).not.toContain('gho_1234567890abcdef');
  });

  it('redacts a Bearer authorization header', () => {
    const out = redact('Authorization: Bearer abcdefghij1234567890');
    expect(out).not.toContain('abcdefghij1234567890');
  });

  it('redacts a GitLab personal access token', () => {
    expect(redact('using glpat-abcdefghijklmnopqrst')).not.toContain('glpat-abcdefghijklmnopqrst');
  });

  it('redacts an OpenAI/xAI style API key', () => {
    expect(redact('key sk-abcdefghijklmnop')).not.toContain('sk-abcdefghijklmnop');
    expect(redact('key xai-abcdefghijklmnop')).not.toContain('xai-abcdefghijklmnop');
  });

  it('redacts JSON token fields but keeps the key name and surrounding JSON legible', () => {
    const out = redact('{"access_token":"supersecretvalue","other":"fine"}');
    expect(out).not.toContain('supersecretvalue');
    expect(out).toContain('"access_token":"[redacted]"');
    expect(out).toContain('"other":"fine"');
  });

  it('redacts form-encoded token fields', () => {
    const out = redact('grant_type=authorization_code&code=abcd1234efgh&redirect_uri=https://x');
    expect(out).not.toContain('abcd1234efgh');
  });

  it('redacts authorization and API-key values embedded in URLs or JSON', () => {
    const out = redact('https://example.test/cb?api_key=abcdefghijklmnop&code=qrstuvwxyz12345 {"authorization":"secret-value-123"}');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain('qrstuvwxyz12345');
    expect(out).not.toContain('secret-value-123');
  });

  it('leaves ordinary text untouched', () => {
    expect(redact('Model endpoint returned 429: rate limited')).toBe('Model endpoint returned 429: rate limited');
  });
});

describe('redactedError', () => {
  it('produces an Error with a redacted message', () => {
    const err = redactedError('failed with access_token=abcdefghijklmnop');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('abcdefghijklmnop');
  });
});

describe('redactFields', () => {
  it('redacts every string field', () => {
    const out = redactFields({ a: 'token=gho_1234567890abcdef', b: 42, c: 'plain text' });
    expect(out.a).not.toContain('gho_1234567890abcdef');
    expect(out.b).toBe(42);
    expect(out.c).toBe('plain text');
  });
});
