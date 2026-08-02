// Notebook overview generation (NotebookLM-style): synthesize a per-repository
// overview, key topics, and suggested questions from a strided sample of the
// repo's chunks. Runs in the service worker; persistence + sampling live in the
// offscreen repo store (offscreenClient.notebookSample/notebookSet). The prompt
// builder and reply parser are pure so they can be unit-tested without a model.

import type { LlmMessage } from './llmProvider';
import { complete, resolveModelForRole } from './llmProvider';
import { extractJsonObject } from './scopedSubtask';
import { notebookSample, notebookSet } from './offscreenClient';
import type { NotebookOverview, Settings } from '../shared/types';

const SAMPLE_CHUNKS = 40;
const PER_CHUNK_CHARS = 600;
const TOTAL_BUDGET_CHARS = 16000;

interface CorpusSample {
  docs: Array<{ id: string; name: string }>;
  chunkCount: number;
  samples: Array<{ docId: string; name: string; text: string }>;
}

const SYSTEM_PROMPT =
  'You are creating a "notebook" overview of a collection of documents for a reader who has not read them. ' +
  'Base everything ONLY on the provided document list and sample passages — do not invent facts. ' +
  'Return ONLY JSON in this exact shape: {"overview": string, "keyTopics": string[], "suggestedQuestions": string[]}. ' +
  'overview: 2–4 short markdown paragraphs on what this collection is about, its main themes, and notable entities. ' +
  'keyTopics: 4–8 short topic labels (2–4 words each). ' +
  'suggestedQuestions: 4–6 specific questions a reader could ask that these documents can answer.';

/** Build the user-message content from a sampled corpus, within a char budget. */
export function buildOverviewPrompt(sample: CorpusSample): string {
  const docList = sample.docs.map((d) => `- ${d.name}`).join('\n');
  const passages: string[] = [];
  let used = 0;
  for (const s of sample.samples) {
    const text = s.text.slice(0, PER_CHUNK_CHARS).trim();
    if (!text) continue;
    if (used + text.length > TOTAL_BUDGET_CHARS) break;
    used += text.length;
    passages.push(`[${s.name}] ${text}`);
  }
  return `Documents (${sample.docs.length}):\n${docList}\n\nSample passages:\n${passages.join('\n\n')}`;
}

export interface ParsedOverview {
  overviewMarkdown: string;
  keyTopics: string[];
  suggestedQuestions: string[];
}

function strList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, cap);
}

/** Parse the synthesis model's JSON reply; tolerant of fences/prose (returns null if unusable). */
export function parseOverview(raw: string): ParsedOverview | null {
  let obj: { overview?: unknown; keyTopics?: unknown; suggestedQuestions?: unknown } | null;
  try {
    obj = extractJsonObject(raw) as typeof obj; // throws when no JSON object is present
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const overviewMarkdown = typeof obj.overview === 'string' ? obj.overview.trim() : '';
  const keyTopics = strList(obj.keyTopics, 12);
  const suggestedQuestions = strList(obj.suggestedQuestions, 8);
  if (!overviewMarkdown && keyTopics.length === 0 && suggestedQuestions.length === 0) return null;
  return { overviewMarkdown, keyTopics, suggestedQuestions };
}

/** A cached overview is stale when the repo's doc/chunk counts have moved since it was made. */
export function isOverviewStale(overview: NotebookOverview | null, docCount: number, chunkCount: number): boolean {
  if (!overview) return true;
  return overview.docCount !== docCount || overview.chunkCount !== chunkCount;
}

export interface GenerateResult {
  ok: boolean;
  overview?: NotebookOverview;
  error?: string;
}

/** Sample the repo, synthesize an overview, persist it, and return it. */
export async function generateNotebookOverview(
  settings: Settings,
  repo: string,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const sampleRes = await notebookSample(repo, SAMPLE_CHUNKS);
  if (!sampleRes.ok) return { ok: false, error: sampleRes.error };
  const sample = sampleRes.result as CorpusSample;
  if (!sample || sample.chunkCount === 0) {
    return { ok: false, error: 'This repository has no indexed content to summarize yet.' };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildOverviewPrompt(sample) },
  ];
  let content: string | null;
  try {
    const reply = await complete(resolveModelForRole(settings, 'utility'), messages, undefined, signal);
    content = reply.content;
  } catch (e) {
    return { ok: false, error: `Overview generation failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const parsed = parseOverview(content ?? '');
  if (!parsed) return { ok: false, error: 'The model did not return a usable overview.' };

  const overview: NotebookOverview = {
    ...parsed,
    docCount: sample.docs.length,
    chunkCount: sample.chunkCount,
    generatedAt: new Date().toISOString(),
  };
  const setRes = await notebookSet(repo, overview);
  if (!setRes.ok) return { ok: false, error: setRes.error };
  return { ok: true, overview };
}
