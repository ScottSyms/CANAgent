// =============================================================================
// Credential redaction for every provider log line and thrown error. Every
// provider module routes outbound diagnostics through `redact()` before they
// reach console.*, a thrown Error, or a BackgroundEvent the UI displays — the
// goal is that a token, authorization code, or client secret can never appear
// in the service worker console, an error banner, or (eventually) a bug
// report, even if a provider's HTTP error body happens to echo one back.
// =============================================================================

const REDACTED = '[redacted]';

// Simple prefix/shape patterns: each replaces its whole match with a fixed
// placeholder. No two of these can match the same text as each other's
// *output* (none of the placeholders below look like a token), so running
// them in sequence over the progressively-redacted string is safe.
const SIMPLE_PATTERNS: RegExp[] = [
  // GitHub OAuth App / PAT token prefixes.
  /\bgh[oprsu]_[A-Za-z0-9]{10,}\b/g,
  // Generic bearer/authorization header value.
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
  // GitLab personal/OAuth access tokens.
  /\bglpat-[A-Za-z0-9_-]{10,}\b/g,
  /\bgl[oa]a-[A-Za-z0-9_-]{10,}\b/gi,
  // OpenAI / xAI style API keys.
  /\b(sk|xai)-[A-Za-z0-9_-]{10,}\b/g,
];

// key/value shapes: replaced with `key=[redacted]` or `"key":"[redacted]"`
// (keeping the surrounding punctuation valid) rather than a bare placeholder,
// so each one's *own* replacement text cannot be re-matched by the *other*
// key/value pattern below (colon-shaped output never matches the
// equals-shaped regex and vice versa) — this is what previously let the
// form-urlencoded pattern re-match and overrun past the JSON pattern's output.
const SECRET_KEYS = 'access_token|refresh_token|id_token|client_secret|authorization|api_key|code|device_code';
const JSON_FIELD_PATTERN = new RegExp(`"(${SECRET_KEYS})"\\s*:\\s*"[^"]{4,}"`, 'gi');
const FORM_FIELD_PATTERN = new RegExp(`\\b(${SECRET_KEYS})=[^&\\s"'}\\],]{4,}`, 'gi');

/** Replace anything that looks like a credential/token/secret with a fixed placeholder. */
export function redact(input: string): string {
  let out = input;
  for (const pattern of SIMPLE_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(JSON_FIELD_PATTERN, (_m, key: string) => `"${key}":"${REDACTED}"`);
  out = out.replace(FORM_FIELD_PATTERN, (_m, key: string) => `${key}=${REDACTED}`);
  return out;
}

/** Build an Error whose `.message` has been passed through `redact()`. */
export function redactedError(message: string): Error {
  return new Error(redact(message));
}

/** Redact every string field of a shallow object (for structured diagnostic logs). */
export function redactFields<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (typeof value === 'string') {
      (out as Record<string, unknown>)[key] = redact(value);
    }
  }
  return out;
}
