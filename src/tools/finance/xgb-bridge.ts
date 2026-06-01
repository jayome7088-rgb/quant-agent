// XGBoost bridge — calls Python subprocess for XGBoost training.
// Types mirror the Python XGBoost trainer output JSON exactly.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINER_PATH = join(__dirname, 'xgb_trainer.py');

function findPython(): string {
  // Try common Python paths
  const candidates = [
    'python',
    'python3',
    process.env.PYTHON_PATH,
    ...(process.platform === 'win32'
      ? [
          'C:\\Users\\jc\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
          'C:\\Python312\\python.exe',
        ]
      : ['/usr/bin/python3', '/usr/local/bin/python3']),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      const proc = Bun.spawnSync([c, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode === 0) return c;
    } catch {
      // not found, continue
    }
  }
  throw new Error(
    'Python not found. Install Python 3.12+ from https://python.org and ensure it is in PATH.',
  );
}

// ---------------------------------------------------------------------------
// Types (same interface as before)
// ---------------------------------------------------------------------------

export interface TrainingConfig {
  windowSize: number;
  testSize: number;
  stepSize: number;
  xgbParams?: Record<string, unknown>;
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  windowSize: 250,
  testSize: 60,        // longer test period → better generalization estimate
  stepSize: 25,
  xgbParams: {
    objective: 'binary:logistic',
    eval_metric: 'logloss',
    max_depth: 3,        // reduced from 4 → less overfitting
    learning_rate: 0.02, // reduced from 0.03 → smoother convergence
    n_estimators: 120,   // reduced from 150
    subsample: 0.7,      // reduced from 0.8 → more randomness
    colsample_bytree: 0.7,
    min_child_weight: 5, // prevent overly specific leaf splits
    reg_lambda: 3.0,     // L2 regularization ↑ (was 1.0)
    reg_alpha: 0.5,      // L1 regularization ↑ (was 0.1)
    gamma: 0.1,          // minimum loss reduction for split
    random_state: 42,
  },
};

export interface FeatureImportance {
  feature: string;
  coefficient: number;   // gain value from XGBoost (tree model, not linear coeff)
  gain: number;           // raw XGBoost gain (same as coefficient for tree models)
  absImportance: number;  // importance value after normalization
  importancePct: number;  // percentage of total gain (sum = 100%)
}

export interface RollingWindowResult {
  windowIndex: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  predictions: number[];
  actuals: number[];
}

export interface ModelOutput {
  coefficients: number[];
  featureImportance: FeatureImportance[];
  rollingResults: RollingWindowResult[];
  aggregateMetrics: {
    avgAccuracy: number;
    avgPrecision: number;
    avgRecall: number;
    avgF1: number;
  };
  allPredictions: number[];
  nextDayProbability: number;
}

// ---------------------------------------------------------------------------
// Python bridge
// ---------------------------------------------------------------------------

export async function trainXGBoost(
  X: number[][],
  y: number[],
  featureNames: string[],
  config: TrainingConfig = DEFAULT_TRAINING_CONFIG,
): Promise<ModelOutput> {
  const python = findPython();
  const input = JSON.stringify({ X, y, feature_names: featureNames, config });
  const proc = Bun.spawn([python, TRAINER_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  proc.stdin.write(new TextEncoder().encode(input));
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 60_000);

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    throw new Error(`XGBoost training timed out after 60s`);
  }

  if (exitCode !== 0) {
    const errMsg = stderr.trim() || output.trim() || `Python exited with code ${exitCode}`;
    throw new Error(`XGBoost training failed: ${errMsg}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`XGBoost returned invalid JSON. stdout: ${output.slice(0, 500)}`);
  }

  if (parsed.error) {
    throw new Error(`XGBoost error: ${parsed.error}`);
  }

  return parsed as ModelOutput;
}
