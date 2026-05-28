// Tests the stock_analyzer pipeline. Falls back to synthetic data if API is rate-limited.
import { normalizeTicker, fetchChart, fetchQuote, OHLCVBar } from './tools/finance/eastmoney-api.js';
import { computeIndicators, extractTrainingMatrix, MODEL_FEATURE_NAMES } from './tools/finance/indicator-engine.js';
import { trainXGBoost, DEFAULT_TRAINING_CONFIG } from './tools/finance/xgb-bridge.js';
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from './tools/finance/backtest-engine.js';
import { formatStockAnalysis } from './tools/finance/output-formatter.js';

const TICKER = process.argv[2] || 'AAPL';
console.log(`\n=== stock_analyzer pipeline: ${TICKER} ===\n`);

const { symbol, market } = normalizeTicker(TICKER);
console.log(`1. Ticker: ${TICKER} -> ${symbol} (${market})`);

// --------------------------------------------------------------------------
// Data fetching with synthetic fallback
// --------------------------------------------------------------------------

function syntheticBars(n: number, startPrice = 180, seed = 42): OHLCVBar[] {
  // Deterministic random with seed
  let r = seed;
  const rand = () => { r = (r * 1664525 + 1013904223) | 0; return (r >>> 0) / 0xFFFFFFFF; };
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  const bars: OHLCVBar[] = [];
  let close = startPrice;
  let volBase = 50e6;
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;

  for (let i = 0; i < n; i++) {
    const dailyReturn = gauss() * 0.02; // 2% daily vol
    const intradayVol = close * (Math.abs(gauss()) * 0.008 + 0.002); // intraday range
    const open = close * (1 + gauss() * 0.003);
    close = close * (1 + dailyReturn);
    const high = Math.max(open, close) + Math.abs(gauss()) * intradayVol * 0.5;
    const low = Math.min(open, close) - Math.abs(gauss()) * intradayVol * 0.5;
    volBase = volBase * (1 + gauss() * 0.1);
    const volume = Math.max(1e6, volBase * (0.5 + rand() * 1.5));

    bars.push({
      timestamp: now - (n - i) * day,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(volume),
    });
  }
  return bars;
}

let intradayBars: OHLCVBar[];
let historicalBars: OHLCVBar[];
let quote: { symbol: string; price: number; change: number; changePercent: number; dayHigh: number; dayLow: number; volume: number; marketTime: number };
let useSynthetic = false;

console.log('2. Fetching intraday data...');
try {
  const r = await fetchChart(symbol, '5m', '5d');
  intradayBars = r.quotes;
  console.log(`   ${intradayBars.length} bars from Yahoo Finance`);
} catch (err: any) {
  console.log(`   API unavailable (${err.message.slice(0, 60)}...), using synthetic data`);
  intradayBars = syntheticBars(78, 185, 1); // ~1 day of 5m bars
  useSynthetic = true;
}

console.log('3. Fetching historical data...');
try {
  const r = await fetchChart(symbol, '1d', '2y');
  historicalBars = r.quotes;
  console.log(`   ${historicalBars.length} bars from Yahoo Finance`);
} catch (err: any) {
  console.log(`   API unavailable, generating synthetic 2y data`);
  historicalBars = syntheticBars(504, 150, 42);
  useSynthetic = true;
}

console.log('4. Quote...');
try {
  quote = await fetchQuote(symbol);
  console.log(`   $${quote.price.toFixed(2)}`);
} catch {
  const b = intradayBars[intradayBars.length - 1];
  quote = {
    symbol, price: b.close, change: b.close - intradayBars[0].open,
    changePercent: (b.close - intradayBars[0].open) / intradayBars[0].open * 100,
    dayHigh: Math.max(...intradayBars.map(x => x.high)),
    dayLow: Math.min(...intradayBars.map(x => x.low)),
    volume: intradayBars.reduce((s, x) => s + x.volume, 0),
    marketTime: b.timestamp,
  };
  console.log(`   $${quote.price.toFixed(2)} (synthetic)`);
}

if (useSynthetic) console.log('\n⚠️  Using synthetic data — API rate limited from sandbox. Real data on your terminal.\n');

// --------------------------------------------------------------------------
// Compute & Train
// --------------------------------------------------------------------------

console.log('5. Computing indicators...');
const ind = computeIndicators(historicalBars, market);
const { X, y } = extractTrainingMatrix(ind);
console.log(`   ${X.length} samples, ${X[0]?.length ?? 0} features, valid from bar ${ind.validStartIndex}`);

console.log('6. XGBoost training...');
const model = await trainXGBoost(X, y, MODEL_FEATURE_NAMES, DEFAULT_TRAINING_CONFIG);
console.log(`   ${model.rollingResults.length} rolling windows`);
console.log(`   Avg accuracy: ${(model.aggregateMetrics.avgAccuracy * 100).toFixed(1)}%`);
console.log(`   Avg F1: ${model.aggregateMetrics.avgF1.toFixed(3)}`);
console.log(`   Next-day probability: ${(model.nextDayProbability * 100).toFixed(1)}%`);
console.log(`   Top 3 features:`);
for (const f of model.featureImportance.slice(0, 3)) {
  console.log(`     ${f.feature}: ${f.importancePct.toFixed(1)}%`);
}

console.log('7. Backtesting...');
const bt = runBacktest(ind.closes.slice(ind.validStartIndex), model.allPredictions, DEFAULT_BACKTEST_CONFIG);
console.log(`   ${bt.metrics.totalTrades} trades | win rate ${bt.metrics.winRate.toFixed(1)}% | return ${bt.metrics.totalReturnPct >= 0 ? '+' : ''}${bt.metrics.totalReturnPct.toFixed(2)}%`);
console.log(`   Sharpe: ${bt.metrics.sharpeRatio.toFixed(2)} | max DD: ${bt.metrics.maxDrawdownPct.toFixed(2)}%`);
console.log(`   Profit factor: ${bt.metrics.profitFactor === Infinity ? '∞' : bt.metrics.profitFactor.toFixed(2)}`);

// --------------------------------------------------------------------------
// Output
// --------------------------------------------------------------------------

console.log('8. Formatting...\n');
const dataTime = useSynthetic ? new Date().toISOString() : new Date(intradayBars[0].timestamp * 1000).toISOString();
const output = formatStockAnalysis({
  ticker: symbol, market,
  currentPrice: quote.price, dayChange: quote.change, dayChangePct: quote.changePercent,
  dayHigh: quote.dayHigh, dayLow: quote.dayLow, volume: quote.volume,
  dataTime,
  indicators: ind, modelOutput: model, backtestResult: bt, intradayInterval: '5m',
});

console.log(output);
console.log('\n=== PIPELINE TEST COMPLETE ===');
