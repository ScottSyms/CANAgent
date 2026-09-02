import { describe, expect, it } from 'vitest';
import { challengeFromVerifier, parseRedirect, randomToken, startOAuthAttempt, validateRedirect } from './oauthPkce';

describe('randomToken / challengeFromVerifier', () => {
  it('produces distinct high-entropy base64url tokens', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(32);
  });

  it('derives a stable S256 challenge from the same verifier', async () => {
    const verifier = 'fixed-verifier-value-for-testing-purposes';
    const c1 = await challengeFromVerifier(verifier);
    const c2 = await challengeFromVerifier(verifier);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c1).not.toContain('=');
  });
});

describe('startOAuthAttempt', () => {
  it('produces fresh state/verifier/challenge material with a future expiry', async () => {
    const attempt = await startOAuthAttempt();
    expect(attempt.state).toBeTruthy();
    expect(attempt.verifier).toBeTruthy();
    expect(attempt.challenge).toBe(await challengeFromVerifier(attempt.verifier));
    expect(attempt.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('parseRedirect', () => {
  it('extracts code and state', () => {
    expect(parseRedirect('https://ext.chromiumapp.org/cb?code=abc123&state=xyz')).toEqual({
      code: 'abc123',
      state: 'xyz',
    });
  });

  it('surfaces a provider error', () => {
    expect(parseRedirect('https://ext.chromiumapp.org/cb?error=access_denied&error_description=nope')).toEqual({
      error: 'nope',
    });
  });

  it('reports missing code', () => {
    expect(parseRedirect('https://ext.chromiumapp.org/cb?state=xyz').error).toMatch(/no authorization code/i);
  });

  it('reports a malformed URL', () => {
    expect(parseRedirect('not a url').error).toMatch(/malformed/i);
  });
});

describe('validateRedirect', () => {
  const origin = 'https://ext.chromiumapp.org';
  const callback = `${origin}/cb`;

  it('accepts a matching state and origin', async () => {
    const attempt = await startOAuthAttempt();
    const redirect = `${origin}/cb?code=goodcode&state=${attempt.state}`;
    expect(validateRedirect(redirect, attempt, callback)).toEqual({ code: 'goodcode' });
  });

  it('rejects a state mismatch (CSRF/replay protection)', async () => {
    const attempt = await startOAuthAttempt();
    const redirect = `${origin}/cb?code=goodcode&state=forged-state`;
    expect(() => validateRedirect(redirect, attempt, callback)).toThrow(/state did not match/i);
  });

  it('rejects an origin mismatch', async () => {
    const attempt = await startOAuthAttempt();
    const redirect = `https://evil.example/cb?code=goodcode&state=${attempt.state}`;
    expect(() => validateRedirect(redirect, attempt, callback)).toThrow(/unexpected callback/i);
  });

  it('rejects a callback path mismatch', async () => {
    const attempt = await startOAuthAttempt();
    const redirect = `${origin}/other?code=goodcode&state=${attempt.state}`;
    expect(() => validateRedirect(redirect, attempt, callback)).toThrow(/unexpected callback/i);
  });

  it('rejects an expired attempt even with a matching state', async () => {
    const attempt = await startOAuthAttempt(-1); // already expired
    const redirect = `${origin}/cb?code=goodcode&state=${attempt.state}`;
    expect(() => validateRedirect(redirect, attempt, callback)).toThrow(/timed out/i);
  });

  it('propagates a provider error from the redirect', async () => {
    const attempt = await startOAuthAttempt();
    const redirect = `${origin}/cb?error=access_denied&error_description=user+declined&state=${attempt.state}`;
    expect(() => validateRedirect(redirect, attempt, callback)).toThrow(/user declined/i);
  });
});
