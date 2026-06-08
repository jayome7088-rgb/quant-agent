// Technical indicator computation — pure TypeScript, zero look-ahead bias.
// All indicators only use data up to and including the current bar.
import type { OHLCVBar } from './yahoo-api.js';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : sum(arr) / arr.length;
}

function stddev(arr: number[], avg?: number): number {
  if (arr.length < 2) return 0;
  const m = avg ?? mean(arr);
  const variance = sum(arr.map((v) => (v - m) ** 2)) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Rolling simple moving average over a window. Returns NaN until window is full. */
function rollingSma(values: number[], window: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= window) s -= values[i - window];
    if (i >= window - 1) out[i] = s / window;
  }
  return out;
}

/** Exponential moving average. First value is SMA(window), then EMA thereafter. */
function ema(values: number[], window: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  const multiplier = 2 / (window + 1);
  // Seed with SMA for the first window
  let startIdx = -1;
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    const allFinite = slice.every((v) => isFinite(v));
    if (allFinite) {
      startIdx = i;
      out[i] = mean(slice);
      break;
    }
  }
  if (startIdx === -1) return out;
  for (let i = startIdx + 1; i < values.length; i++) {
    out[i] = (values[i] - out[i - 1]) * multiplier + out[i - 1];
  }
  return out;
}

/** Rolling max over a window (lookback). */
function rollingMax(values: number[], window: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = window - 1; i < values.length; i++) {
    out[i] = Math.max(...values.slice(i - window + 1, i + 1));
  }
  return out;
}

/** Rolling min over a window (lookback). */
function rollingMin(values: number[], window: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = window - 1; i < values.length; i++) {
    out[i] = Math.min(...values.slice(i - window + 1, i + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndicatorFeatures {
  // Price / candle features
  limitUpDown: number[];
  bigBullishCandle: number[];
  bigBearishCandle: number[];
  upperShadow: number[];
  lowerShadow: number[];
  drawdown: number[];
  // Volume features
  volumeAnomaly: number[];
  volumeTrend: number[];
  // Volatility features
  volatility: number[];
  atr: number[];
  // Technical indicators
  sma5: number[];
  sma10: number[];
  sma20: number[];
  sma60: number[];
  smaRatio: number[];
  maCrossover: number[];
  rsi14: number[];
  macd: number[];
  macdSignal: number[];
  macdHistogram: number[];
  bollingerUpper: number[];
  bollingerLower: number[];
  bollingerPosition: number[];
  atrNormalized: number[];
  // Fundamental features (constant per stock, repeated across all bars)
  peRatio: number[];
  pbRatio: number[];
  revenueGrowth: number[];
  earningsGrowth: number[];
  grossMargin: number[];
  netMargin: number[];
  roe: number[];
  // Capital flow factors (OHLCV proxies)
  largeOrderRatio: number[];
  mainForceControl: number[];
  capitalFlowMomentum: number[];
  priceVolumeCorr: number[];
  volumeMomentum: number[];
  // Volume-price composite factors
  rsiDivergence: number[];
  bollingerBreakout: number[];
  intradaySkew: number[];
  volumeVariation: number[];
  priceVolumeTension: number[];
  // Position / volume-based features
  pricePosition: number[];
  volumeConcentration: number[];
  // Target
  nextDayDirection: number[];
}

export interface IndicatorMatrix {
  closes: number[];
  volumes: number[];
  highs: number[];
  lows: number[];
  opens: number[];
  returns: number[];
  features: IndicatorFeatures;
  /** First index where ALL features are non-NaN — start training/eval from here. */
  validStartIndex: number;
}

/** Ordered list of feature names used for model training (matches column order in the matrix). */
export const MODEL_FEATURE_NAMES = [
  // Technical (17→14, removed volatility/macdHistogram/atrNormalized as redundant)
  'limitUpDown',
  'bigBullishCandle',
  'bigBearishCandle',
  'upperShadow',
  'lowerShadow',
  'drawdown',
  'volumeAnomaly',
  'volumeTrend',
  'atr',
  'smaRatio',
  'maCrossover',
  'rsi14',
  'macd',
  'bollingerPosition',
  // Capital flow factors (new)
  'largeOrderRatio',
  'mainForceControl',
  'capitalFlowMomentum',
  'priceVolumeCorr',
  'volumeMomentum',
  // Volume-price composite factors (new)
  'rsiDivergence',
  'bollingerBreakout',
  'intradaySkew',
  'volumeVariation',
  'priceVolumeTension',
  // Position
  'pricePosition',
  'volumeConcentration',
  // Fundamental
  'peRatio',
  'pbRatio',
  'revenueGrowth',
  'earningsGrowth',
  'grossMargin',
  'netMargin',
  'roe',
];

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

export interface FundamentalSnapshot {
  peRatio?: number;
  pbRatio?: number;
  revenueGrowth?: number;
  earningsGrowth?: number;
  grossMargin?: number;
  netMargin?: number;
  roe?: number;
}

export function computeIndicators(bars: OHLCVBar[], market = 'US', fundamentals?: FundamentalSnapshot): IndicatorMatrix {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const opens = bars.map((b) => b.open);

  // Log returns
  const returns: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    returns[i] = Math.log(closes[i] / closes[i - 1]);
  }

  // Limit up/down threshold by market
  const limitThreshold = market === 'HK' ? 0.20 : market === 'US' ? 0.15 : 0.095;

  // SMA series
  const sma5 = rollingSma(closes, 5);
  const sma10 = rollingSma(closes, 10);
  const sma20 = rollingSma(closes, 20);
  const sma60 = rollingSma(closes, 60);

  // RSI(14)
  const rsi14 = computeRSI(closes, 14);

  // MACD(12, 26, 9)
  const { macd, macdSignal, macdHistogram } = computeMACD(closes);

  // Bollinger Bands(20, 2)
  const { upper: bbUpper, lower: bbLower } = computeBollingerBands(closes, 20, 2);

  // ATR(14)
  const atr = computeATR(highs, lows, closes, 14);

  // Volatility (rolling 20-period stddev of returns)
  const volatility: number[] = new Array(n).fill(NaN);
  for (let i = 19; i < n; i++) {
    volatility[i] = stddev(returns.slice(i - 19, i + 1));
  }

  // Volume SMA
  const volSma20 = rollingSma(volumes, 20);

  // Volume trend (slope of volSma20 over last 5 periods)
  const volumeTrend: number[] = new Array(n).fill(NaN);
  for (let i = 24; i < n; i++) {
    // Simple linear regression slope of volSma20 over last 5 valid points
    if (isFinite(volSma20[i]) && isFinite(volSma20[i - 4])) {
      volumeTrend[i] = (volSma20[i] - volSma20[i - 4]) / 4;
    }
  }

  // Rolling peak for drawdown
  const peak20 = rollingMax(closes, 20);

  // Build per-bar features
  const f: IndicatorFeatures = {
    limitUpDown: new Array(n).fill(NaN),
    bigBullishCandle: new Array(n).fill(NaN),
    bigBearishCandle: new Array(n).fill(NaN),
    upperShadow: new Array(n).fill(NaN),
    lowerShadow: new Array(n).fill(NaN),
    drawdown: new Array(n).fill(NaN),
    volumeAnomaly: new Array(n).fill(NaN),
    volumeTrend: volumeTrend,
    volatility: volatility,
    atr: new Array(n).fill(NaN),
    sma5,
    sma10,
    sma20,
    sma60,
    smaRatio: new Array(n).fill(NaN),
    maCrossover: new Array(n).fill(NaN),
    rsi14,
    macd,
    macdSignal,
    macdHistogram,
    bollingerUpper: bbUpper,
    bollingerLower: bbLower,
    bollingerPosition: new Array(n).fill(NaN),
    atrNormalized: new Array(n).fill(NaN),
    // Fundamental (constant across bars, filled after loop)
    peRatio: new Array(n).fill(NaN),
    pbRatio: new Array(n).fill(NaN),
    revenueGrowth: new Array(n).fill(NaN),
    earningsGrowth: new Array(n).fill(NaN),
    grossMargin: new Array(n).fill(NaN),
    netMargin: new Array(n).fill(NaN),
    roe: new Array(n).fill(NaN),
    // Capital flow
    largeOrderRatio: new Array(n).fill(NaN),
    mainForceControl: new Array(n).fill(NaN),
    capitalFlowMomentum: new Array(n).fill(NaN),
    priceVolumeCorr: new Array(n).fill(NaN),
    volumeMomentum: new Array(n).fill(NaN),
    // Volume-price composite
    rsiDivergence: new Array(n).fill(NaN),
    bollingerBreakout: new Array(n).fill(NaN),
    intradaySkew: new Array(n).fill(NaN),
    volumeVariation: new Array(n).fill(NaN),
    priceVolumeTension: new Array(n).fill(NaN),
    // Position
    pricePosition: new Array(n).fill(NaN),
    volumeConcentration: new Array(n).fill(NaN),
    nextDayDirection: new Array(n).fill(NaN),
  };

  for (let i = 0; i < n; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    const v = volumes[i];

    // Candle features
    const range = h - l;
    if (range > 0) {
      f.upperShadow[i] = (h - Math.max(o, c)) / range;
      f.lowerShadow[i] = (Math.min(o, c) - l) / range;
    }

    if (o > 0) {
      const candleRet = (c - o) / o;
      f.bigBullishCandle[i] = candleRet > 0.03 ? 1 : 0;
      f.bigBearishCandle[i] = candleRet < -0.03 ? 1 : 0;
    }

    // Limit up/down
    if (i > 0 && closes[i - 1] > 0) {
      const dailyRet = (c - closes[i - 1]) / closes[i - 1];
      f.limitUpDown[i] = Math.abs(dailyRet) >= limitThreshold ? Math.sign(dailyRet) : 0;
    }

    // Drawdown
    if (i >= 19 && isFinite(peak20[i]) && peak20[i] > 0) {
      f.drawdown[i] = (c - peak20[i]) / peak20[i];
    }

    // Volume anomaly
    if (isFinite(volSma20[i]) && volSma20[i] > 0) {
      f.volumeAnomaly[i] = v / volSma20[i] - 1;
    }

    // SMA ratio & crossover
    if (isFinite(sma20[i]) && sma20[i] > 0) {
      f.smaRatio[i] = c / sma20[i] - 1;
    }
    if (isFinite(sma5[i]) && isFinite(sma20[i])) {
      f.maCrossover[i] = sma5[i] > sma20[i] ? 1 : 0;
    }

    // Bollinger position
    if (isFinite(bbUpper[i]) && isFinite(bbLower[i]) && bbUpper[i] !== bbLower[i]) {
      f.bollingerPosition[i] = (c - bbLower[i]) / (bbUpper[i] - bbLower[i]);
    }

    // ATR
    if (isFinite(atr[i]) && c > 0) {
      f.atr[i] = atr[i];
      f.atrNormalized[i] = atr[i] / c;
    }

    // Next-day direction (target)
    if (i < n - 1) {
      f.nextDayDirection[i] = closes[i + 1] > c ? 1 : 0;
    }

    // Price position: where current price sits in 60-day range (proxy 获利比例)
    if (i >= 60) {
      const max60 = Math.max(...highs.slice(i - 59, i + 1));
      const min60 = Math.min(...lows.slice(i - 59, i + 1));
      if (max60 > min60) {
        f.pricePosition[i] = (c - min60) / (max60 - min60);
      }
    }

    // Volume concentration: recent 5-day avg vol / 60-day avg vol (proxy 筹码集中度)
    if (i >= 60 && volSma20[i] > 0) {
      const recentVol = volumes.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
      const longVol = volumes.slice(i - 59, i + 1).reduce((a, b) => a + b, 0) / 60;
      if (longVol > 0) {
        f.volumeConcentration[i] = recentVol / longVol;
      }
    }

    // Intraday skew: (high-close)/(close-low), >1 = selling pressure, <1 = buying support
    const downRange = c - l;
    if (downRange > 0) {
      f.intradaySkew[i] = (h - c) / downRange;
    }

    // Price-volume tension: normalized directional volume
    if (o > 0 && isFinite(volSma20[i]) && volSma20[i] > 0) {
      f.priceVolumeTension[i] = ((c - o) / o) * (v / volSma20[i]);
    }

    // Bollinger breakout: normalized distance from mid band
    if (isFinite(bbUpper[i]) && isFinite(bbLower[i]) && bbUpper[i] !== bbLower[i]) {
      f.bollingerBreakout[i] = (c - sma20[i]) / (bbUpper[i] - bbLower[i]);
    }

    // Volume momentum: 5-day volume trend acceleration
    if (i >= 5 && isFinite(volumeTrend[i])) {
      const prevTrend = isFinite(volumeTrend[i - 5]) ? volumeTrend[i - 5] : 0;
      f.volumeMomentum[i] = volumeTrend[i] - prevTrend;
    }
  }

  // Second-pass multi-bar computations
  // Capital flow momentum: rate of change of volume anomaly over 5 days
  for (let i = 5; i < n; i++) {
    if (isFinite(f.volumeAnomaly[i]) && isFinite(f.volumeAnomaly[i - 5])) {
      f.capitalFlowMomentum[i] = f.volumeAnomaly[i] - f.volumeAnomaly[i - 5];
    }
  }

  // Large order ratio: K-line body dominance × volume intensity (proxy)
  for (let i = 0; i < n; i++) {
    const range = highs[i] - lows[i];
    if (range > 0 && isFinite(volSma20[i]) && volSma20[i] > 0) {
      const bodyRatio = Math.abs(closes[i] - opens[i]) / range; // 0-1
      f.largeOrderRatio[i] = bodyRatio * (volumes[i] / volSma20[i]);
    }
  }

  // Main force control: volume concentration × price momentum
  for (let i = 20; i < n; i++) {
    if (isFinite(f.volumeConcentration[i]) && closes[i - 20] > 0) {
      const mom20 = (closes[i] - closes[i - 20]) / closes[i - 20];
      f.mainForceControl[i] = f.volumeConcentration[i] * mom20;
    }
  }

  // Price-volume Pearson correlation (20-day rolling, negative factor)
  for (let i = 20; i < n; i++) {
    const cSlice = closes.slice(i - 19, i + 1);
    const vSlice = volumes.slice(i - 19, i + 1);
    const cMean = mean(cSlice);
    const vMean = mean(vSlice);
    let cov = 0, cVar = 0, vVar = 0;
    for (let j = 0; j < 20; j++) {
      const cDiff = cSlice[j] - cMean;
      const vDiff = vSlice[j] - vMean;
      cov += cDiff * vDiff;
      cVar += cDiff * cDiff;
      vVar += vDiff * vDiff;
    }
    if (cVar > 0 && vVar > 0) {
      f.priceVolumeCorr[i] = cov / Math.sqrt(cVar * vVar);
    }
  }

  // Volume variation (CV of volume over 5 days, %)
  for (let i = 5; i < n; i++) {
    const vSlice = volumes.slice(i - 4, i + 1);
    const vMean = mean(vSlice);
    if (vMean > 0) {
      f.volumeVariation[i] = (stddev(vSlice, vMean) / vMean) * 100;
    }
  }

  // RSI divergence: price makes new high but RSI doesn't (bearish), or vice versa
  for (let i = 20; i < n; i++) {
    const price20High = Math.max(...closes.slice(i - 19, i + 1));
    const price20Low = Math.min(...closes.slice(i - 19, i + 1));
    const rsi20High = Math.max(...f.rsi14.slice(i - 19, i + 1).filter(isFinite));
    const rsi20Low = Math.min(...f.rsi14.slice(i - 19, i + 1).filter(isFinite));

    const priceAtHigh = closes[i] >= price20High * 0.99;
    const priceAtLow = closes[i] <= price20Low * 1.01;
    const rsiAtHigh = f.rsi14[i] >= rsi20High * 0.99;
    const rsiAtLow = f.rsi14[i] <= rsi20Low * 1.01;

    if (priceAtHigh && !rsiAtHigh) f.rsiDivergence[i] = -1;      // bearish divergence
    else if (priceAtLow && !rsiAtLow) f.rsiDivergence[i] = 1;    // bullish divergence
    else f.rsiDivergence[i] = 0;
  }

  // Fill fundamental features (constant across all bars)
  // When fundamentals unavailable, fill with 0 (neutral) instead of NaN
  // Otherwise NaN fundamentals block ALL rows in extractRows
  const pe = (fundamentals?.peRatio && fundamentals.peRatio > 0) ? fundamentals.peRatio : 0;
  const pb = (fundamentals?.pbRatio && fundamentals.pbRatio > 0) ? fundamentals.pbRatio : 0;
  const rg = fundamentals && isFiniteNum(fundamentals.revenueGrowth) ? fundamentals.revenueGrowth! : 0;
  const eg = fundamentals && isFiniteNum(fundamentals.earningsGrowth) ? fundamentals.earningsGrowth! : 0;
  const gm = fundamentals && isFiniteNum(fundamentals.grossMargin) ? fundamentals.grossMargin! : 0;
  const nm = fundamentals && isFiniteNum(fundamentals.netMargin) ? fundamentals.netMargin! : 0;
  const re = fundamentals && isFiniteNum(fundamentals.roe) ? fundamentals.roe! : 0;
  for (let i = 0; i < n; i++) {
    f.peRatio[i] = pe;
    f.pbRatio[i] = pb;
    f.revenueGrowth[i] = rg;
    f.earningsGrowth[i] = eg;
    f.grossMargin[i] = gm;
    f.netMargin[i] = nm;
    f.roe[i] = re;
  }

  // Fill any remaining NaN model features with 0 (handles short-history IPOs).
  // SMA60, smaRatio, etc. may be NaN when n < 60 bars.
  for (const name of MODEL_FEATURE_NAMES) {
    const arr = f[name as keyof IndicatorFeatures];
    for (let i = 0; i < n; i++) {
      if (!isFinite(arr[i])) arr[i] = 0;
    }
  }

  // Also fill nextDayDirection NaN (last bar) with 0
  for (let i = 0; i < n; i++) {
    if (!isFinite(f.nextDayDirection[i])) f.nextDayDirection[i] = 0;
  }

  // Find validStartIndex: first bar where label exists
  let validStartIndex = 0;
  for (let i = 20; i < n - 1; i++) {
    if (f.nextDayDirection[i] !== 0 || i > 20) {
      validStartIndex = i;
      break;
    }
  }
  validStartIndex = Math.min(validStartIndex, n - 2);

  return { closes, volumes, highs, lows, opens, returns, features: f, validStartIndex };
}

// ---------------------------------------------------------------------------
// Individual indicator implementations
// ---------------------------------------------------------------------------

function computeRSI(closes: number[], period: number): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss over the first `period` changes
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss += -delta;
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    out[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    out[period] = 100 - 100 / (1 + rs);
  }

  // Wilder's smoothing for remaining bars
  for (let i = period + 1; i < n; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) {
      out[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }

  return out;
}

function computeMACD(closes: number[]): {
  macd: number[];
  macdSignal: number[];
  macdHistogram: number[];
} {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const n = closes.length;
  const macd: number[] = new Array(n).fill(NaN);
  const signal: number[] = new Array(n).fill(NaN);
  const histogram: number[] = new Array(n).fill(NaN);

  // MACD line: ema12 - ema26
  for (let i = 0; i < n; i++) {
    if (isFinite(ema12[i]) && isFinite(ema26[i])) {
      macd[i] = ema12[i] - ema26[i];
    }
  }

  // Signal line: 9-period EMA of MACD
  const macdValid = macd.filter((v) => isFinite(v));
  const signalValid = ema(macdValid, 9);
  let si = 0;
  const macdValidStart = macd.findIndex((v) => isFinite(v));
  for (let i = 0; i < n; i++) {
    if (i >= macdValidStart && si < signalValid.length) {
      signal[i] = signalValid[si++];
    }
  }

  // Histogram: MACD - signal
  for (let i = 0; i < n; i++) {
    if (isFinite(macd[i]) && isFinite(signal[i])) {
      histogram[i] = macd[i] - signal[i];
    }
  }

  return { macd, macdSignal: signal, macdHistogram: histogram };
}

function computeBollingerBands(
  closes: number[],
  period: number,
  multiplier: number,
): { upper: number[]; middle: number[]; lower: number[] } {
  const n = closes.length;
  const middle = rollingSma(closes, period);
  const upper: number[] = new Array(n).fill(NaN);
  const lower: number[] = new Array(n).fill(NaN);

  for (let i = period - 1; i < n; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const sd = stddev(slice, middle[i]);
    upper[i] = middle[i] + multiplier * sd;
    lower[i] = middle[i] - multiplier * sd;
  }

  return { upper, middle, lower };
}

function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function computeATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  const n = highs.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n < period + 1) return out;

  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    tr.push(trueRange(highs[i], lows[i], closes[i - 1]));
  }

  // Initial ATR = average of first `period` TR values
  out[period] = mean(tr.slice(0, period));

  // Wilder's smoothing
  for (let i = period + 1; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i - 1]) / period;
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature preprocessing pipeline
// ═══════════════════════════════════════════════════════════════════════════

/** Fill NaN values with column-wise median. */
export function medianImpute(X: number[][]): number[][] {
  if (X.length === 0) return X;
  const cols = X[0].length;
  const result = X.map(row => [...row]);

  for (let j = 0; j < cols; j++) {
    const vals: number[] = [];
    for (let i = 0; i < result.length; i++) {
      if (isFinite(result[i][j])) vals.push(result[i][j]);
    }
    if (vals.length === 0) continue;
    vals.sort((a, b) => a - b);
    const median = vals.length % 2 === 0
      ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
      : vals[Math.floor(vals.length / 2)];

    for (let i = 0; i < result.length; i++) {
      if (!isFinite(result[i][j])) result[i][j] = median;
    }
  }
  return result;
}

/** Z-score standardize: (x - mean) / std. Returns standardized copy. */
export function zscoreNormalize(X: number[][]): number[][] {
  if (X.length === 0) return X;
  const cols = X[0].length;
  const result = X.map(row => [...row]);

  for (let j = 0; j < cols; j++) {
    const vals = result.map(r => r[j]).filter(isFinite);
    if (vals.length === 0) continue;
    const m = mean(vals);
    const s = stddev(vals, m);
    if (s === 0) continue;
    for (let i = 0; i < result.length; i++) {
      if (isFinite(result[i][j])) result[i][j] = (result[i][j] - m) / s;
    }
  }
  return result;
}

/** Pearson correlation between two arrays. */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const aMean = mean(a.slice(0, n));
  const bMean = mean(b.slice(0, n));
  let cov = 0, aVar = 0, bVar = 0;
  for (let i = 0; i < n; i++) {
    const aDiff = a[i] - aMean;
    const bDiff = b[i] - bMean;
    cov += aDiff * bDiff;
    aVar += aDiff * aDiff;
    bVar += bDiff * bDiff;
  }
  if (aVar === 0 || bVar === 0) return 0;
  return cov / Math.sqrt(aVar * bVar);
}

/**
 * Filter highly correlated features (r > threshold).
 * For each correlated pair, keep the feature with higher IC (correlation with y).
 * Returns filtered MODEL_FEATURE_NAMES and the corresponding column mask.
 */
export function filterCorrelatedFeatures(
  X: number[][], y: number[], names: string[], threshold = 0.7,
): { filteredNames: string[]; columnMask: number[] } {
  if (X.length === 0) return { filteredNames: names, columnMask: names.map((_, i) => i) };

  const cols = X[0].length;
  // Compute IC (Information Coefficient = Pearson correlation with target) for each feature
  const ic: number[] = [];
  for (let j = 0; j < cols; j++) {
    const col = X.map(r => r[j]);
    ic.push(Math.abs(pearson(col, y)));
  }

  // Build correlation matrix and greedily drop features
  const keep: boolean[] = new Array(cols).fill(true);
  for (let j = 0; j < cols; j++) {
    if (!keep[j]) continue;
    for (let k = j + 1; k < cols; k++) {
      if (!keep[k]) continue;
      const r = Math.abs(pearson(
        X.map(row => row[j]),
        X.map(row => row[k]),
      ));
      if (r > threshold) {
        // Drop the one with lower IC
        if (ic[j] >= ic[k]) {
          keep[k] = false;
        } else {
          keep[j] = false;
          break; // j dropped, move to next j
        }
      }
    }
  }

  const filteredNames = names.filter((_, i) => keep[i]);
  const columnMask = keep.map((k, i) => k ? i : -1).filter(i => i >= 0);
  return { filteredNames, columnMask };
}

/**
 * Extract the feature matrix X and label vector y from the indicator matrix.
 * Returns only rows where all features and the target are valid.
 */
export function extractTrainingMatrix(
  matrix: IndicatorMatrix,
): { X: number[][]; y: number[] } {
  const { features, validStartIndex } = matrix;
  const n = matrix.closes.length;
  const X: number[][] = [];
  const y: number[] = [];

  for (let i = validStartIndex; i < n && isFinite(features.nextDayDirection[i]); i++) {
    const row: number[] = [];
    for (const name of MODEL_FEATURE_NAMES) {
      row.push(features[name as keyof IndicatorFeatures][i]);
    }
    X.push(row);
    y.push(features.nextDayDirection[i]);
  }

  return { X, y };
}
