// Universal model pool trainer — multi-stock, time-split, model persistence.
// Trains ONE XGBoost model on all HSI constituents, saves to disk.
// Individual queries use the saved model for prediction (no per-query training).
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'node:fs';
import type { OHLCVBar } from './eastmoney-api.js';
import { fetchSinaChart } from './sina-api.js';
import { computeIndicators, MODEL_FEATURE_NAMES, type IndicatorMatrix, type FundamentalSnapshot } from './indicator-engine.js';
import type { ModelOutput, FeatureImportance } from './xgb-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINER_PATH = join(__dirname, 'pool-trainer.py');
const MODEL_PATH = join(__dirname, 'universal_model.json');

// ═══════════════════════════════════════════════════════════════════════════
// HSI Constituents (2026) — 恒生指数成分股
// ═══════════════════════════════════════════════════════════════════════════

export const HSI_STOCKS = [
  '00005', '00011', '00012', '00016', '00017', '00027', '00066', '00101',
  '00175', '00241', '00267', '00268', '00288', '00291', '00316', '00388',
  '00669', '00688', '00700', '00762', '00823', '00857', '00868', '00881',
  '00883', '00939', '00941', '00981', '00992', '01038', '01044', '01088',
  '01093', '01109', '01113', '01171', '01209', '01211', '01299', '01378',
  '01398', '01810', '01876', '01928', '01929', '01997', '02015', '02018',
  '02020', '02269', '02313', '02318', '02319', '02331', '02359', '02382',
  '02388', '02628', '02638', '02688', '02899', '03690', '03888', '03968',
  '03988', '06618', '09618', '09626', '09633', '09660', '09868', '09888',
  '09901', '09961', '09988', '09999',
];

// ═══════════════════════════════════════════════════════════════════════════
// Model state
// ═══════════════════════════════════════════════════════════════════════════

let cachedModel: PoolModel | null = null;
let trainingPromise: Promise<PoolModel> | null = null;

export interface PoolModel {
  featureImportance: FeatureImportance[];
  inSampleAccuracy: number;
  outSampleAccuracy: number;
  totalSamples: number;
  trainSamples: number;
  testSamples: number;
  modelPath: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export function isModelAvailable(): boolean {
  return existsSync(MODEL_PATH);
}

export function getCachedModel(): PoolModel | null {
  return cachedModel;
}

export async function ensureModel(): Promise<PoolModel> {
  if (cachedModel) return cachedModel;
  if (trainingPromise) return trainingPromise;
  trainingPromise = trainUniversalModel();
  cachedModel = await trainingPromise;
  trainingPromise = null;
  return cachedModel;
}

/** Predict next-day probabilities for a single stock using the universal model. */
export async function predictWithUniversalModel(
  featureMatrix: number[][],
  featureNames: string[],
): Promise<{ allPredictions: number[]; nextDayProbability: number; featureImportance: FeatureImportance[] }> {
  await ensureModel();
  const python = findPython();
  const input = JSON.stringify({
    mode: 'predict',
    X: featureMatrix,
    feature_names: featureNames,
  });

  const proc = Bun.spawn([python, TRAINER_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(new TextEncoder().encode(input));
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Pool prediction failed: ${stderr || stdout}`);
  }

  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(parsed.error);

  return {
    allPredictions: parsed.allPredictions || [],
    nextDayProbability: parsed.nextDayProbability || 0.5,
    featureImportance: parsed.featureImportance || [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Training
// ═══════════════════════════════════════════════════════════════════════════

async function trainUniversalModel(): Promise<PoolModel> {
  console.log('[pool] Starting universal model training...');
  console.log(`[pool] Stock pool: ${HSI_STOCKS.length} HSI constituents`);

  const allRows: { features: number[]; label: number; date: string }[] = [];

  let fetched = 0;
  for (const code of HSI_STOCKS) {
    try {
      const ticker = `${code}.HK`;
      // Fetch 5 years of daily data
      const chart = await fetchSinaChart(ticker, '1d', '5y');
      const bars: OHLCVBar[] = chart.quotes;
      if (bars.length < 200) {
        console.log(`[pool]   ${code} skipped: only ${bars.length} bars`);
        continue;
      }

      // Compute indicators for this stock
      const matrix = computeIndicators(bars, 'HK');
      const rows = extractRows(matrix, bars);
      allRows.push(...rows);
      fetched++;
      console.log(`[pool]   ${code} OK: ${rows.length} rows (${bars.length} bars)`);
    } catch (e) {
      console.log(`[pool]   ${code} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Small delay between fetches to avoid rate-limit
    if (fetched % 10 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[pool] Fetched ${fetched}/${HSI_STOCKS.length} stocks, ${allRows.length} total rows`);

  if (allRows.length < 10000) {
    throw new Error(`Insufficient training data: ${allRows.length} rows (need >= 10000)`);
  }

  // Sort all rows by date (strict chronological order)
  allRows.sort((a, b) => a.date.localeCompare(b.date));

  // Extract X and y matrices
  const X = allRows.map(r => r.features);
  const y = allRows.map(r => r.label);
  const dates = allRows.map(r => r.date);

  // Call Python for training
  const python = findPython();
  const input = JSON.stringify({
    mode: 'train',
    pool_name: '恒生指数成分股',
    pool_size: fetched,
    feature_names: MODEL_FEATURE_NAMES,
    dates,
    X, y,
    config: {
      xgbParams: {
        objective: 'binary:logistic', eval_metric: 'logloss',
        max_depth: 3, learning_rate: 0.02, n_estimators: 120,
        subsample: 0.7, colsample_bytree: 0.7,
        min_child_weight: 5, reg_lambda: 3.0, reg_alpha: 0.5,
        gamma: 0.1, random_state: 42,
      },
    },
  });

  const proc = Bun.spawn([python, TRAINER_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(new TextEncoder().encode(input));
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // Print all stderr (diagnostic output)
  console.log(stderr);

  if (exitCode !== 0) {
    throw new Error(`Pool training failed: ${stderr || stdout}`);
  }

  const result = JSON.parse(stdout);
  if (result.error) throw new Error(result.error);

  return {
    featureImportance: result.featureImportance || [],
    inSampleAccuracy: result.inSampleAccuracy,
    outSampleAccuracy: result.outSampleAccuracy,
    totalSamples: result.totalSamples,
    trainSamples: result.trainSamples,
    testSamples: result.testSamples,
    modelPath: result.modelPath,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function findPython(): string {
  const candidates = [
    'python', 'python3', process.env.PYTHON_PATH,
    ...(process.platform === 'win32'
      ? ['C:\\Users\\jc\\AppData\\Local\\Programs\\Python\\Python312\\python.exe', 'C:\\Python312\\python.exe']
      : ['/usr/bin/python3', '/usr/local/bin/python3']),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const proc = Bun.spawnSync([c, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode === 0) return c;
    } catch { /* continue */ }
  }
  throw new Error('Python not found.');
}

function extractRows(matrix: IndicatorMatrix, bars: OHLCVBar[]): { features: number[]; label: number; date: string }[] {
  const rows: { features: number[]; label: number; date: string }[] = [];
  const { features, validStartIndex } = matrix;
  const n = matrix.closes.length;

  for (let i = validStartIndex; i < n && i < features.nextDayDirection.length; i++) {
    if (!isFinite(features.nextDayDirection[i])) continue;
    const row: number[] = [];
    for (const name of MODEL_FEATURE_NAMES) {
      row.push(features[name as keyof typeof features][i]);
    }
    // Skip rows with any NaN features
    if (row.some(v => !isFinite(v))) continue;

    const dt = new Date((bars[i]?.timestamp || 0) * 1000);
    const dateStr = dt.toISOString().slice(0, 10);

    rows.push({ features: row, label: features.nextDayDirection[i], date: dateStr });
  }
  return rows;
}
