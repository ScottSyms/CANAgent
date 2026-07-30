// =============================================================================
// In-flight checkpoint — the narrow slice of task state needed to know a task
// was interrupted mid-run and restore its working context after the MV3 service
// worker is evicted. This is the fix technical-debt.md §8.2 defers: the
// conversation body is already autosaved each turn, but *in-flight* progress
// (which step, current plan/findings) was in-memory only and lost on eviction.
//
// Single slot: only one task runs at a time (see automation.ts's one-at-a-time
// gate), so one `ba_inflight` key suffices. Written at each step boundary,
// cleared when the task settles. A present checkpoint on service-worker startup
// means "a task was cut off here".
// =============================================================================

import type { PlanStepStatus } from './types';

const INFLIGHT_KEY = 'ba_inflight';

export interface InFlightCheckpoint {
  conversationId: string;
  epoch: number;
  stepsUsed: number;
  stepBudget: number;
  plan: { text: string; status: PlanStepStatus }[] | null;
  findings: string[];
  lastTaskUrl?: string;
  lastUserText: string;
  unattended: boolean;
  /** How many times this interruption has already been auto-resumed (see recovery.ts). */
  recoveryAttempts?: number;
  updatedAt: string; // ISO-8601
}

export async function writeCheckpoint(cp: InFlightCheckpoint): Promise<void> {
  await chrome.storage.local.set({ [INFLIGHT_KEY]: cp });
}

export async function readCheckpoint(): Promise<InFlightCheckpoint | null> {
  const result = await chrome.storage.local.get(INFLIGHT_KEY);
  const cp = result[INFLIGHT_KEY] as InFlightCheckpoint | undefined;
  return cp ?? null;
}

export async function clearCheckpoint(): Promise<void> {
  await chrome.storage.local.remove(INFLIGHT_KEY);
}
