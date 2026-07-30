// =============================================================================
// Audit event schema + helpers. Mirrors specification.md §14.1, trimmed to what
// the runtime can actually populate today. The design rule: store *digests, not
// payloads* — the log records SHA-256 of tool inputs/outputs, never the content
// itself, so page text and credentials never land in the audit trail (satisfies
// spec §8.8 exclusion and §13 minimization). Pure module (crypto.subtle is
// available in every extension context); the OPFS writer lives in auditLog.ts.
// =============================================================================

export type AuditEventType =
  | 'TOOL_EXECUTED'
  | 'TOOL_DENIED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'POLICY_DECISION'
  | 'MODEL_CALL'
  | 'CHECKPOINT_WRITTEN'
  | 'RECOVERY';

export interface AuditEvent {
  eventId: string; // crypto.randomUUID()
  timestamp: string; // ISO-8601
  conversationId: string | null; // maps to spec's taskId
  eventType: AuditEventType;
  tool?: string;
  target?: { tabId?: number; origin?: string };
  inputDigest?: string; // sha256Hex(JSON.stringify(args))
  outputDigest?: string; // sha256Hex(result)
  approvalId?: string | null;
  policyDecision?: 'allow' | 'deny' | 'needs_approval' | null;
  policyRule?: string; // e.g. 'financial_legal_disabled' when denied
  result?: 'success' | 'error' | 'denied';
  durationMs?: number;
  unattended?: boolean; // scheduled/triggered run vs. attended chat
}

/** SHA-256 as lowercase hex. Used for input/output digests. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keys whose values must never appear (even truncated) in a bound approval. */
const SENSITIVE_ARG_KEYS = /(password|token|secret|apikey|api_key|authorization|cookie|ssn|card)/i;

/**
 * Shallow-redact a tool's args for storage in an ApprovalContext preview:
 * sensitive-looking keys become '[redacted]', long strings are truncated. This
 * is for the *approval binding* (so an approval preview can't leak a secret),
 * distinct from the audit log, which stores only digests and never args.
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_ARG_KEYS.test(k)) {
      out[k] = '[redacted]';
    } else if (typeof v === 'string') {
      out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}
