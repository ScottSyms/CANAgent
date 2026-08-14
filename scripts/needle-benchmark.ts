import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import type { Settings } from '../src/shared/types.ts';

function parseArgs(argv: string[]): { backup?: string; corpusSizes: number[]; realEmbeddings: boolean; e2eCitations: boolean } {
  let backup = process.env.CANCHAT_BACKUP_PATH;
  let corpusSizes = [500, 2000, 10000];
  let realEmbeddings = false;
  let e2eCitations = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backup') backup = argv[++i];
    else if (argv[i] === '--corpus-sizes') corpusSizes = (argv[++i] ?? '').split(',').map(Number).filter((n) => n > 0);
    else if (argv[i] === '--real-embeddings') realEmbeddings = true;
    else if (argv[i] === '--e2e-citations') {
      realEmbeddings = true;
      e2eCitations = true;
    }
  }
  return { backup, corpusSizes, realEmbeddings, e2eCitations };
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

const { backup, corpusSizes, realEmbeddings, e2eCitations } = parseArgs(process.argv.slice(2));

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const mod = (await server.ssrLoadModule('/src/background/needleBenchmark.ts')) as {
    runSyntheticNeedle: typeof import('../src/background/needleBenchmark.ts').runSyntheticNeedle;
    runRealEmbeddingNeedle: typeof import('../src/background/needleBenchmark.ts').runRealEmbeddingNeedle;
    runCitationNeedle: typeof import('../src/background/needleBenchmark.ts').runCitationNeedle;
  };

  console.log('=== Synthetic needle-in-haystack (no credentials -- ranking/fusion machinery at scale) ===');
  const synthRows = corpusSizes.map((size) => {
    const r = mod.runSyntheticNeedle(size);
    return {
      'Corpus size': size,
      'Needle rank': r.needleRank < 0 ? 'NOT FOUND' : r.needleRank,
      'Hit@1': r.metrics.hitRateAtK,
      'Recall@3': r.metrics.recallAtK,
    };
  });
  console.table(synthRows);
  if (synthRows.some((r) => r['Needle rank'] === 'NOT FOUND')) {
    console.error('FAIL: the synthetic needle benchmark failed to retrieve the planted fact at one or more corpus sizes.');
    process.exitCode = 1;
  }

  if (!realEmbeddings) {
    console.log('\nSkipping real-embedding / citation modes (pass --real-embeddings or --e2e-citations, plus --backup <path>).');
  } else {
    if (!backup) throw new Error('--real-embeddings requires --backup <path-to-exported-backup.json> (or CANCHAT_BACKUP_PATH).');
    const settings = loadSettings(backup);
    if (corpusSizes.some((n) => n >= 2000)) {
      console.log(
        `\nNote: real-embedding mode issues one embedding API call per ~64 chunks for each corpus size below -- ` +
          `this may take a while and incur cost depending on your endpoint's pricing.`,
      );
    }
    console.log(`\n=== Real-embedding needle-in-haystack (endpoint: ${settings.baseUrl}) ===`);
    const realRows: Array<{ 'Corpus size': number; 'Needle rank': number | string; 'Hit@1': number; 'Recall@3': number }> = [];
    for (const size of corpusSizes) {
      const r = await mod.runRealEmbeddingNeedle(settings, size);
      realRows.push({
        'Corpus size': size,
        'Needle rank': r.needleRank < 0 ? 'NOT FOUND' : r.needleRank,
        'Hit@1': r.metrics.hitRateAtK,
        'Recall@3': r.metrics.recallAtK,
      });
    }
    console.table(realRows);
    if (realRows.some((r) => r['Needle rank'] === 'NOT FOUND')) {
      console.error('FAIL: real-embedding retrieval did not find the planted needle at one or more corpus sizes.');
      process.exitCode = 1;
    }

    if (e2eCitations) {
      console.log('\n=== End-to-end citation check (retrieve + generate + validate [[sentence-id]]) ===');
      const size = corpusSizes[Math.min(1, corpusSizes.length - 1)];
      const r = await mod.runCitationNeedle(settings, size);
      console.log(
        `Corpus size ${size}: needle rank ${r.retrieval.needleRank < 0 ? 'NOT FOUND' : r.retrieval.needleRank}, cited=${r.cited}`,
      );
      console.log(`Model answer: ${r.answer}`);
      if (!r.cited) {
        console.error('FAIL: the model did not cite the planted needle sentence id in its answer.');
        process.exitCode = 1;
      }
    }
  }
} finally {
  await server.close();
}
