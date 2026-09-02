// =============================================================================
// Durable job engine — the alarm-driven loop that runs long fan-out jobs across
// service-worker evictions. Each tick processes a bounded batch within a soft
// wall-clock budget, checkpoints the frontier + findings, then re-arms a
// chrome.alarm to resume (reconciled on SW startup). Job-type behavior (seed /
// runItem / reduce) is injected via registerJobType, so the engine is generic;
// researchJob.ts registers the first type. Mirrors scheduler.ts's alarm+reconcile
// pattern; persistence is jobStore.ts.
// =============================================================================

import { mapWithConcurrency } from '../shared/asyncPool';
import type { Settings } from '../shared/types';
import {
  addLeads,
  isExhausted,
  markProcessed,
  takeBatch,
  withinLimits,
  type FrontierItem,
  type FrontierState,
  type JobLimits,
  type JobRecord,
  type JobType,
} from '../shared/jobs';
import {
  appendFindings,
  getJob,
  getJobs,
  readFindings,
  readFrontier,
  saveJob,
  writeFrontier,
  type JobFinding,
} from './jobStore';
import { notifyRunComplete } from './scheduler';
import { getSettings } from './storage';

export const JOB_ALARM_PREFIX = 'job:';
const SOFT_BUDGET_MS = 4 * 60_000; // process at most ~4 min per wake, then re-arm
const RESUME_DELAY_MS = 5_000; // arm the next tick soon (Chrome may clamp to ~30–60s)

export interface JobItemOutcome {
  finding: JobFinding;
  /** New leads discovered while processing this item (dedup/depth-capped by the engine). */
  leads: Array<{ url?: string; query?: string }>;
}

/** A job type plugs in these behaviors. `seed`/`runItem`/`reduce` may call the model/browser. */
export interface JobTypeHandler {
  seed(settings: Settings, job: JobRecord): Promise<FrontierState>;
  runItem(settings: Settings, job: JobRecord, item: FrontierItem, signal: AbortSignal): Promise<JobItemOutcome>;
  /** Synthesize findings → a saved report; returns its productStore filename. */
  reduce(settings: Settings, job: JobRecord, findings: JobFinding[]): Promise<string>;
}

const handlers: Partial<Record<JobType, JobTypeHandler>> = {};
export function registerJobType(type: JobType, handler: JobTypeHandler): void {
  handlers[type] = handler;
}

function alarmName(id: string): string {
  return `${JOB_ALARM_PREFIX}${id}`;
}
export function jobIdFromAlarm(name: string): string | null {
  return name.startsWith(JOB_ALARM_PREFIX) ? name.slice(JOB_ALARM_PREFIX.length) : null;
}
function armTick(id: string, delayMs: number): void {
  chrome.alarms.create(alarmName(id), { when: Date.now() + Math.max(0, delayMs) });
}

/** Create and start a durable job. Returns immediately; the first tick seeds it. */
export async function startJob(type: JobType, objective: string, title: string, limits: JobLimits): Promise<JobRecord> {
  const now = Date.now();
  const job: JobRecord = {
    id: crypto.randomUUID(),
    type,
    title: title.trim() || 'Job',
    objective: objective.trim(),
    status: 'queued',
    limits,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    processed: 0,
    pending: 0,
  };
  await saveJob(job);
  armTick(job.id, 0);
  return job;
}

export async function pauseJob(id: string): Promise<void> {
  const j = await getJob(id);
  if (j && (j.status === 'running' || j.status === 'queued')) {
    await saveJob({ ...j, status: 'paused', updatedAt: Date.now() });
  }
  await chrome.alarms.clear(alarmName(id));
}

export async function resumeJob(id: string): Promise<void> {
  const j = await getJob(id);
  if (j && j.status === 'paused') {
    await saveJob({ ...j, status: 'running', updatedAt: Date.now() });
    armTick(id, 0);
  }
}

export async function cancelJob(id: string): Promise<void> {
  const j = await getJob(id);
  if (j && !['done', 'failed', 'cancelled'].includes(j.status)) {
    await saveJob({ ...j, status: 'cancelled', finishedAt: Date.now(), updatedAt: Date.now() });
  }
  await chrome.alarms.clear(alarmName(id));
}

/** On SW startup, re-arm alarms for any job that was mid-flight (survives eviction). */
export async function reconcileJobs(): Promise<void> {
  for (const j of await getJobs()) {
    if (j.status === 'running' || j.status === 'queued' || j.status === 'reducing') armTick(j.id, RESUME_DELAY_MS);
  }
}

async function finish(job: JobRecord, status: 'done' | 'failed', error?: string, reportName?: string): Promise<void> {
  await saveJob({ ...job, status, error, reportName, finishedAt: Date.now(), updatedAt: Date.now() });
  await chrome.alarms.clear(alarmName(job.id));
  notifyRunComplete(job.title, status === 'done' ? 'ok' : 'error', error, reportName ? [reportName] : undefined);
}

async function reduceAndFinish(job: JobRecord, handler: JobTypeHandler, settings: Settings): Promise<void> {
  await saveJob({ ...job, status: 'reducing', updatedAt: Date.now() });
  try {
    const reportName = await handler.reduce(settings, job, await readFindings(job.id));
    await finish({ ...job, status: 'reducing' }, 'done', undefined, reportName);
  } catch (e) {
    await finish(job, 'failed', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Advance one job by a bounded amount, then either finish (frontier exhausted /
 * caps hit) or re-arm to continue. Safe to call cold (a fresh SW wake): it loads
 * the checkpointed frontier and resumes without reprocessing.
 */
export async function tick(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  if (['paused', 'cancelled', 'done', 'failed'].includes(job.status)) return;
  const handler = handlers[job.type];
  if (!handler) return void finish(job, 'failed', `No handler registered for job type "${job.type}".`);

  const settings = await getSettings();
  if (!settings) {
    // Not configured / vault locked — retry later rather than failing the job.
    armTick(jobId, RESUME_DELAY_MS);
    return;
  }

  // Seed on first tick.
  let frontier: FrontierState | null = await readFrontier(jobId);
  if (!frontier) {
    try {
      frontier = await handler.seed(settings, job);
      await writeFrontier(jobId, frontier);
    } catch (e) {
      return void finish(job, 'failed', e instanceof Error ? e.message : String(e));
    }
  }
  await saveJob({ ...job, status: 'running', pending: frontier.pending.length, processed: frontier.processedCount, updatedAt: Date.now() });

  const controller = new AbortController();
  const deadline = Date.now() + SOFT_BUDGET_MS;
  try {
    while (!isExhausted(frontier) && Date.now() < deadline && withinLimits(job, frontier, Date.now()).ok) {
      // Honor pause/cancel at the batch boundary.
      const fresh = await getJob(jobId);
      if (!fresh || fresh.status === 'paused' || fresh.status === 'cancelled') {
        await writeFrontier(jobId, frontier);
        return;
      }
      const { batch, rest } = takeBatch(frontier, job.limits.maxConcurrency);
      const outcomes = await mapWithConcurrency(batch, job.limits.maxConcurrency, (item) =>
        handler.runItem(settings, job, item, controller.signal),
      );
      await appendFindings(jobId, outcomes.map((o) => o.finding));
      let nextState = markProcessed(rest, batch.length);
      for (let i = 0; i < batch.length; i++) nextState = addLeads(nextState, outcomes[i].leads, batch[i].depth, job.limits);
      frontier = nextState;
      await writeFrontier(jobId, frontier);
      await saveJob({ ...job, status: 'running', pending: frontier.pending.length, processed: frontier.processedCount, updatedAt: Date.now() });
    }
  } catch (e) {
    // A batch failed hard — checkpoint and retry on the next tick (bounded by caps).
    await writeFrontier(jobId, frontier);
    void e;
    armTick(jobId, RESUME_DELAY_MS);
    return;
  }

  if (isExhausted(frontier) || !withinLimits(job, frontier, Date.now()).ok) {
    await reduceAndFinish({ ...job, pending: frontier.pending.length, processed: frontier.processedCount }, handler, settings);
  } else {
    armTick(jobId, RESUME_DELAY_MS); // more work remains; resume after eviction/idle
  }
}
