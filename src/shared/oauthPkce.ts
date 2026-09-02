// =============================================================================
// Generic OAuth 2.0 Authorization Code + PKCE helpers shared by every
// subscription-provider connection (GitHub Copilot's redirect-based fallback,
// GitLab Duo). Pure — no chrome.*/network — so it is unit-testable; the
// interactive launch + token storage lives in background/providers/*.ts.
//
// This generalizes shared/graphAuth.ts's PKCE pair (kept as-is for the
// existing Microsoft Graph mailbox feature) and adds what that module does
// NOT do: `state` generation *and* validation, and callback-origin checking.
// Every new provider connection in this file validates state; skipping it
// would let a stale or forged redirect complete as if it were the user's own
// sign-in.
// =============================================================================

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A high-entropy, base64url random string (RFC 7636 verifier length bounds when byteLen>=32). */
export function randomToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Derive the S256 PKCE code challenge from a verifier. */
export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  return { verifier, challenge: await challengeFromVerifier(verifier) };
}

/** One in-flight authorization attempt's anti-CSRF/replay material. */
export interface OAuthAttempt {
  state: string;
  verifier: string;
  challenge: string;
  /** Epoch ms after which this attempt must be rejected even if the redirect arrives. */
  expiresAt: number;
}

/** Short callback timeout (task requirement): a redirect must land within this window. */
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export async function startOAuthAttempt(timeoutMs = OAUTH_CALLBACK_TIMEOUT_MS): Promise<OAuthAttempt> {
  const { verifier, challenge } = await pkcePair();
  return {
    state: randomToken(24),
    verifier,
    challenge,
    expiresAt: Date.now() + timeoutMs,
  };
}

export interface RedirectResult {
  code?: string;
  state?: string;
  error?: string;
}

/** Pull code/state (or an error) out of a redirect URL, without validating them yet. */
export function parseRedirect(redirectUrl: string): RedirectResult {
  try {
    const u = new URL(redirectUrl);
    const err = u.searchParams.get('error');
    if (err) return { error: u.searchParams.get('error_description') || err };
    const code = u.searchParams.get('code') ?? undefined;
    const state = u.searchParams.get('state') ?? undefined;
    if (!code) return { error: 'No authorization code in the redirect.' };
    return { code, state };
  } catch {
    return { error: 'Malformed redirect URL.' };
  }
}

/**
 * Validate a redirect against the attempt that started it: state must match
 * exactly (CSRF/mix-up protection), the attempt must not have expired (short
 * callback timeout), and the redirect's origin and path must match the expected
 * extension redirect URL (protects against a callback URL substituted by
 * page-controlled content). Throws with a specific, non-credential-bearing
 * message on any mismatch — callers should treat any throw as "reject and
 * discard the attempt", never retry with the same state.
 */
export function validateRedirect(
  redirectUrl: string,
  attempt: OAuthAttempt,
  expectedRedirectUrl: string,
): { code: string } {
  if (Date.now() > attempt.expiresAt) {
    throw new Error('Sign-in timed out. Start again.');
  }
  let redirect: URL;
  let expected: URL;
  try {
    redirect = new URL(redirectUrl);
    expected = new URL(expectedRedirectUrl);
  } catch {
    throw new Error('Malformed redirect URL.');
  }
  if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname) {
    throw new Error('Redirect came from an unexpected callback URL — rejected.');
  }
  const { code, state, error } = parseRedirect(redirectUrl);
  if (error) throw new Error(error);
  if (state !== attempt.state) {
    throw new Error('OAuth state did not match — possible CSRF attempt, rejected.');
  }
  if (!code) throw new Error('No authorization code in the redirect.');
  return { code };
}
