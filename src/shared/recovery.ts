// =============================================================================
// Durable-recovery helpers (specification.md §9.3). Pure logic, split out of the
// runtime so it unit-tests without a model or a browser: how many times to
// re-attempt an interrupted task before giving up, how to reconcile the tabs a
// task expected against the tabs actually open now, and the safe resume prompt
// that tells the model to continue *without* assuming any prior state-changing
// action completed.
// =============================================================================

/**
 * Cap on automatic resume attempts for a single interruption. Each service-worker
 * eviction mid-resume would otherwise re-trigger recovery forever; after this many
 * tries we restore state and let the user drive. Progress within a resume resets
 * the count (a fresh user turn clears the checkpoint entirely).
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

/** Whether an interrupted task should be auto-resumed given how many times we've tried. */
export function shouldAutoResume(attempts: number, max: number = MAX_RECOVERY_ATTEMPTS): boolean {
  return attempts < max;
}

export interface TabExpectation {
  url: string;
  title: string;
}

export interface ReconcileResult {
  /** URLs the task had open that are no longer present. */
  missing: TabExpectation[];
  /** A human/model-readable note, or '' when nothing is missing. */
  note: string;
}

function sameUrl(a: string, b: string): boolean {
  // Compare ignoring a trailing hash; tab URLs often differ only by fragment.
  const strip = (u: string) => u.split('#')[0];
  return strip(a) === strip(b);
}

/**
 * Reconcile the tab group a task was working with against the tabs open now.
 * Missing tabs mean the agent must re-open/re-read rather than assume that page
 * state still exists (spec §9.3.3–9.3.4).
 */
export function reconcileTabs(expected: TabExpectation[], openUrls: string[]): ReconcileResult {
  const missing = expected.filter((e) => !openUrls.some((u) => sameUrl(u, e.url)));
  if (missing.length === 0) return { missing, note: '' };
  const list = missing.map((m) => `"${m.title}" (${m.url})`).join(', ');
  return {
    missing,
    note:
      `${missing.length} page(s) this task had open are no longer available: ${list}. ` +
      `Re-open or re-read them before relying on their contents.`,
  };
}

/**
 * The resume directive handed to the model as the (synthetic) user turn. It
 * frames the continuation and — critically — forbids assuming any send/submit/
 * modify from before the interruption completed. State-changing tools remain
 * approval-gated by the policy engine regardless; this just makes the model
 * reason correctly rather than blindly re-firing them.
 */
export function buildResumePrompt(originalTask: string, stepsUsed: number, reconcileNote: string): string {
  const lines = [
    '[Task recovery] The browser suspended this extension while the task below was running' +
      (stepsUsed > 0 ? ` (around step ${stepsUsed} of your plan).` : '.'),
    'Your plan and findings so far have been restored — continue from where you left off; do not start over.',
    'Page content earlier in this thread may be stale: re-read any page you need before answering about it.',
    'Do NOT assume any earlier send, submit, purchase, or record change actually completed. ' +
      'If finishing requires a state-changing action, request approval for it as normal.',
  ];
  if (reconcileNote) lines.push(reconcileNote);
  lines.push('', `Original task: ${originalTask}`);
  return lines.join('\n');
}
