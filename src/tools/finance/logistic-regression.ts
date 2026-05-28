// Logistic regression with gradient descent, L2 regularization,
// and rolling walk-forward validation — pure TypeScript.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrainingConfig {
  windowSize: number;
  testSize: number;
  stepSize: number;
  learningRate: number;
  maxIterations: number;
  lambdaL2: number;
  convergenceThreshold: number;
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  windowSize: 500,
  testSize: 50,
  stepSize: 25,
  learningRate: 0.01,
  maxIterations: 1000,
  lambdaL2: 0.001,
  convergenceThreshold: 1e-6,
};

export interface FeatureImportance {
  feature: string;
  coefficient: number;
  absImportance: number;
  importancePct: number;
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
// Math helpers
// ---------------------------------------------------------------------------

function sigmoid(z: number): number {
  // Clamp to avoid overflow
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export function trainLogisticRegression(
  X: number[][],
  y: number[],
  featureNames: string[],
  config: TrainingConfig = DEFAULT_TRAINING_CONFIG,
): ModelOutput {
  const nSamples = X.length;
  const nFeatures = featureNames.length;

  if (nSamples === 0 || nFeatures === 0) {
    throw new Error('Training requires at least 1 sample and 1 feature');
  }

  // Standardize features (mean=0, std=1) using TRAINING data only per window
  // We compute global stats here for the feature importance step, but per-window
  // stats are used for actual training to avoid look-ahead.

  const rollingResults: RollingWindowResult[] = [];
  const allPredictions: number[] = [];
  let finalCoefficients: number[] = [];

  let winIdx = 0;
  let trainStart = 0;

  while (trainStart + config.windowSize + config.testSize <= nSamples) {
    const trainEnd = trainStart + config.windowSize;
    const testStart = trainEnd;
    const testEnd = Math.min(testStart + config.testSize, nSamples);

    const Xtrain = X.slice(trainStart, trainEnd);
    const ytrain = y.slice(trainStart, trainEnd);
    const Xtest = X.slice(testStart, testEnd);
    const ytest = y.slice(testStart, testEnd);

    // Standardize using training stats
    const { means, stds } = computeStats(Xtrain, nFeatures);
    const XtrainStd = standardize(Xtrain, means, stds);
    const XtestStd = standardize(Xtest, means, stds);

    // Train on this window
    const coeffs = fitLogistic(XtrainStd, ytrain, config);
    finalCoefficients = coeffs; // last window wins for next-day prediction

    // Predict on test window
    const predictions = XtestStd.map((row) => sigmoid(dot(row, coeffs.slice(1)) + coeffs[0]));
    const predLabels = predictions.map((p) => (p >= 0.5 ? 1 : 0));

    // Metrics
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (let i = 0; i < predLabels.length; i++) {
      if (predLabels[i] === 1 && ytest[i] === 1) tp++;
      else if (predLabels[i] === 1 && ytest[i] === 0) fp++;
      else if (predLabels[i] === 0 && ytest[i] === 0) tn++;
      else fn++;
    }

    const accuracy = (tp + tn) / (tp + tn + fp + fn) || 0;
    const precision = tp / (tp + fp) || 0;
    const recall = tp / (tp + fn) || 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    rollingResults.push({
      windowIndex: winIdx,
      trainStart,
      trainEnd,
      testStart,
      testEnd,
      accuracy,
      precision,
      recall,
      f1,
      predictions,
      actuals: ytest,
    });

    allPredictions.push(...predictions);
    trainStart += config.stepSize;
    winIdx++;

    // Cap at 10 windows
    if (winIdx >= 10) break;
  }

  // Compute aggregate metrics
  const nWindows = rollingResults.length;
  const agg = {
    avgAccuracy: nWindows > 0 ? mean(rollingResults.map((r) => r.accuracy)) : 0,
    avgPrecision: nWindows > 0 ? mean(rollingResults.map((r) => r.precision)) : 0,
    avgRecall: nWindows > 0 ? mean(rollingResults.map((r) => r.recall)) : 0,
    avgF1: nWindows > 0 ? mean(rollingResults.map((r) => r.f1)) : 0,
  };

  // Feature importance from final model coefficients
  const featureImportance = computeFeatureImportance(finalCoefficients, X, featureNames);

  // Next-day probability using the most recent data point
  const lastRow = X[X.length - 1];
  const allMeans = computeStats(X, nFeatures);
  const lastRowStd = standardize([lastRow], allMeans.means, allMeans.stds)[0];
  const nextDayProb = sigmoid(dot(lastRowStd, finalCoefficients.slice(1)) + finalCoefficients[0]);

  return {
    coefficients: finalCoefficients,
    featureImportance,
    rollingResults,
    aggregateMetrics: agg,
    allPredictions,
    nextDayProbability: nextDayProb,
  };
}

// ---------------------------------------------------------------------------
// Core logistic regression fit (batch gradient descent)
// ---------------------------------------------------------------------------

function fitLogistic(
  X: number[][],
  y: number[],
  config: TrainingConfig,
): number[] {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  if (n === 0 || d === 0) return new Array(d + 1).fill(0);

  // Initialize weights (including bias at index 0)
  let w = new Array(d + 1).fill(0);

  for (let iter = 0; iter < config.maxIterations; iter++) {
    // Forward pass
    const preds = X.map((row) => sigmoid(dot(row, w.slice(1)) + w[0]));

    // Gradients
    const grads = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const err = preds[i] - y[i];
      grads[0] += err; // bias
      for (let j = 0; j < d; j++) {
        grads[j + 1] += err * X[i][j];
      }
    }

    // Average + L2 regularization (not on bias)
    for (let j = 0; j <= d; j++) {
      grads[j] /= n;
      if (j > 0) grads[j] += config.lambdaL2 * w[j];
    }

    // Update
    const prevW = [...w];
    for (let j = 0; j <= d; j++) {
      w[j] -= config.learningRate * grads[j];
    }

    // Convergence check
    let maxDelta = 0;
    for (let j = 0; j <= d; j++) {
      maxDelta = Math.max(maxDelta, Math.abs(w[j] - prevW[j]));
    }
    if (maxDelta < config.convergenceThreshold) break;
  }

  return w;
}

// ---------------------------------------------------------------------------
// Standardization helpers
// ---------------------------------------------------------------------------

function computeStats(
  X: number[][],
  nFeatures: number,
): { means: number[]; stds: number[] } {
  const means: number[] = new Array(nFeatures).fill(0);
  const stds: number[] = new Array(nFeatures).fill(0);
  const n = X.length;
  if (n === 0) return { means, stds };

  for (const row of X) {
    for (let j = 0; j < nFeatures; j++) {
      means[j] += row[j];
    }
  }
  for (let j = 0; j < nFeatures; j++) means[j] /= n;

  for (const row of X) {
    for (let j = 0; j < nFeatures; j++) {
      stds[j] += (row[j] - means[j]) ** 2;
    }
  }
  for (let j = 0; j < nFeatures; j++) {
    stds[j] = n > 1 ? Math.sqrt(stds[j] / (n - 1)) : 0;
    if (stds[j] === 0) stds[j] = 1e-8; // avoid division by zero
  }

  return { means, stds };
}

function standardize(X: number[][], means: number[], stds: number[]): number[][] {
  return X.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));
}

// ---------------------------------------------------------------------------
// Feature importance
// ---------------------------------------------------------------------------

function computeFeatureImportance(
  coefficients: number[],
  X: number[][],
  featureNames: string[],
): FeatureImportance[] {
  // coefficients[0] is bias, coefficients[1..] are feature weights
  const weights = coefficients.slice(1);
  const nFeatures = featureNames.length;

  // Compute feature stddevs for standardization
  const { stds } = computeStats(X, nFeatures);

  // Standardized importance = |weight| * stddev(feature)
  const raw: { feature: string; coefficient: number; absImportance: number }[] = [];
  for (let j = 0; j < nFeatures; j++) {
    raw.push({
      feature: featureNames[j],
      coefficient: weights[j] ?? 0,
      absImportance: Math.abs((weights[j] ?? 0) * (stds[j] ?? 1)),
    });
  }

  const total = raw.reduce((s, r) => s + r.absImportance, 0);
  const result: FeatureImportance[] = raw
    .map((r) => ({
      ...r,
      importancePct: total > 0 ? (r.absImportance / total) * 100 : 0,
    }))
    .sort((a, b) => b.absImportance - a.absImportance);

  return result;
}

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}
