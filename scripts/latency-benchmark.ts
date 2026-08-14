import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import type { Settings } from '../src/shared/types.ts';
import type { InternalCorpusResult, LatencyStats, UpstreamResult } from '../src/background/latencyBenchmark.ts';

function parseArgs(argv: string[]): { backup?: string; rounds: number; corpusSizes: number[] } {
  let backup = process.env.CANCHAT_BACKUP_PATH;
  let rounds = 5;
  let corpusSizes = [500, 2000, 10000];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backup') backup = argv[++i];
    else if (argv[i] === '--rounds') rounds = Number(argv[++i]) || rounds;
    else if (argv[i] === '--corpus-sizes') corpusSizes = (argv[++i] ?? '').split(',').map(Number).filter((n) => n > 0);
  }
  return { backup, rounds, corpusSizes };
}

function loadSettings(path: string): Settings {
  const backup = JSON.parse(readFileSync(path, 'utf8')) as { storage?: { ba_settings?: Settings } };
  const settings = backup.storage?.ba_settings;
  if (!settings || !settings.apiKey) {
    throw new Error(
      `No usable Settings in ${path} (missing apiKey). Export a backup from Settings -> Backup & Restore with "Include API key" checked, then pass its path via --backup.`,
    );
  }
  return settings;
}

function fmtStats(s?: LatencyStats): Record<string, string | number> {
  if (!s) return {};
  return { 'min (ms)': s.minMs.toFixed(0), 'p50 (ms)': s.p50Ms.toFixed(0), 'p95 (ms)': s.p95Ms.toFixed(0), 'max (ms)': s.maxMs.toFixed(0), n: s.n };
}

const { backup, rounds, corpusSizes } = parseArgs(process.argv.slice(2));

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const mod = (await server.ssrLoadModule('/src/background/latencyBenchmark.ts')) as {
    measureUpstream: typeof import('../src/background/latencyBenchmark.ts').measureUpstream;
    measureInternal: typeof import('../src/background/latencyBenchmark.ts').measureInternal;
  };

  console.log('=== Internal processing (no network, pure functions, median of', rounds, 'rounds) ===');
  const internalResults: InternalCorpusResult[] = [];
  for (const size of corpusSizes) internalResults.push(await mod.measureInternal(size, 384, rounds));
  console.table(
    internalResults.map((r) => ({
      'Corpus size': r.chunkCount,
      'chunkText (ms)': r.chunkTextMs.p50Ms.toFixed(2),
      'sentenceSplit (ms)': r.sentenceSplitMs.p50Ms.toFixed(2),
      'buildKeywordIndex (ms)': r.keywordIndexMs.p50Ms.toFixed(2),
      'bm25 query (ms)': r.bm25QueryMs.p50Ms.toFixed(2),
      'scoreVectors (ms)': r.vectorScoreMs.p50Ms.toFixed(2),
      'hybridSearch (ms)': r.hybridSearchMs.p50Ms.toFixed(2),
      'graphRank (ms)': r.graphRankMs.p50Ms.toFixed(2),
    })),
  );

  if (!backup) {
    console.log(
      '\nNo --backup <path> (or CANCHAT_BACKUP_PATH) given -- skipping upstream (LLM/embedding) measurement.\n' +
        'Export one from Settings -> Backup & Restore with "Include API key" checked, then re-run with --backup <path>.',
    );
  } else {
    const settings = loadSettings(backup);
    console.log(`\n=== Upstream (real endpoint: ${settings.baseUrl}, model ${settings.model}, ${rounds} rounds) ===`);
    const upstream: UpstreamResult = await mod.measureUpstream(settings, rounds);
    const upstreamRows = [
      { Call: 'complete()', ...fmtStats(upstream.completion) },
      upstream.embedding
        ? { Call: 'embed()', ...fmtStats(upstream.embedding) }
        : { Call: 'embed()', 'p50 (ms)': 'skipped', Note: upstream.embeddingSkippedReason },
    ];
    console.table(upstreamRows);

    const representative = internalResults.find((r) => r.chunkCount >= 2000) ?? internalResults[internalResults.length - 1];
    if (representative) {
      const upstreamMs = upstream.completion.p50Ms + (upstream.embedding?.p50Ms ?? 0);
      const internalMs = representative.hybridSearchMs.p50Ms;
      const total = upstreamMs + internalMs;
      console.log(
        `\nRepresentative turn (1 embed call + 1 search @ ${representative.chunkCount} chunks + 1 completion): ` +
          `upstream ${upstreamMs.toFixed(0)}ms (${((upstreamMs / total) * 100).toFixed(0)}%), ` +
          `internal ${internalMs.toFixed(2)}ms (${((internalMs / total) * 100).toFixed(0)}%).`,
      );
    }
  }
} finally {
  await server.close();
}
