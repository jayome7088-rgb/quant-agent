import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { normalizeTicker, fetchChart, fetchQuote, OHLCVBar } from './eastmoney-api.js';
import { computeIndicators, extractTrainingMatrix, MODEL_FEATURE_NAMES } from './indicator-engine.js';
import { trainXGBoost } from './xgb-bridge.js';
import { runBacktest } from './backtest-engine.js';
import { formatStockAnalysis, buildPlotData } from './output-formatter.js';
import { loadStrategyConfig } from './strategy-config.js';
import { resolvePlotPlaceholders, stripPlotPlaceholders } from './plot-bridge.js';

export const STOCK_ANALYZER_DESCRIPTION = `
Performs comprehensive stock technical analysis including intraday data, technical indicators, machine learning prediction, and backtesting. Use when the user asks for stock analysis, trends, buy/sell recommendations, valuation, or trading signals.

## When to Use

- Stock analysis, trend prediction, buy/sell/hold recommendations
- Technical analysis with ML-based probability prediction
- Trading signal generation with backtested performance metrics
- "Should I buy/sell X?"
- "Analyze X stock"
- "What's the technical outlook for X?"
- Chinese A-share, HK, or US stock analysis

## When NOT to Use

- Fundamental analysis like DCF valuation (use skill: dcf-valuation)
- Financial statement analysis (use get_financials)
- Market-wide screening (use stock_screener)
- News or sentiment analysis (use get_market_data)

## Usage

- Provide the ticker symbol (US, HK, or China A-shares)
- Optionally specify intraday interval (1m/5m/15m/30m/1h, default 5m)
- Returns comprehensive formatted analysis with disclaimer

NOTE: This tool fetches data from East Money (东方财富) API and performs XGBoost training + backtesting. May take 10-30 seconds.
`.trim();

const StockAnalyzerInputSchema = z.object({
  ticker: z.string().describe("The stock ticker symbol. Supports US stocks (AAPL), HK stocks (09868, 0700), and China A-shares (600000, 000001)."),
  interval: z.enum(['1m', '5m', '15m', '30m', '1h']).default('5m').describe("Intraday interval for real-time data. Default 5m."),
});

// ---------------------------------------------------------------------------
// Synthetic data fallback
// ---------------------------------------------------------------------------

function syntheticBars(n: number, startPrice = 180, seed = 42): OHLCVBar[] {
  let r = seed;
  const rand = () => { r = (r * 1664525 + 1013904223) | 0; return (r >>> 0) / 0xFFFFFFFF; };
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  const bars: OHLCVBar[] = [];
  let close = startPrice;
  let volBase = 50e6;
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;

  for (let i = 0; i < n; i++) {
    const dailyReturn = gauss() * 0.02;
    const intradayVol = close * (Math.abs(gauss()) * 0.008 + 0.002);
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

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createStockAnalyzer(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'stock_analyzer',
    description: `Comprehensive ML-based stock analysis tool. Performs: intraday data fetch, technical indicator computation, XGBoost prediction with rolling backtest, and generates a formatted analysis report. Use for stock analysis, trend prediction, buy/sell signals. Falls back to synthetic data if East Money is unreachable.`,
    schema: StockAnalyzerInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      const rawTicker = input.ticker.trim();
      const interval = input.interval ?? '5m';

      // 1. Normalize ticker
      onProgress?.('Normalizing ticker...');
      const { symbol, market } = normalizeTicker(rawTicker);

      let useSynthetic = false;

      // 2. Fetch intraday data
      onProgress?.(`Fetching intraday data for ${symbol}...`);
      let intradayBars: OHLCVBar[];
      try {
        const r = await fetchChart(symbol, interval, '5d');
        intradayBars = r.quotes;
      } catch (err) {
        onProgress?.('Intraday fetch failed, using synthetic data...');
        intradayBars = syntheticBars(78, 185, 1);
        useSynthetic = true;
      }

      // 3. Fetch historical daily data
      onProgress?.('Fetching historical data...');
      let historicalBars: OHLCVBar[];
      try {
        const r = await fetchChart(symbol, '1d', '2y');
        historicalBars = r.quotes;
      } catch (err) {
        onProgress?.('Historical fetch failed, using synthetic data...');
        historicalBars = syntheticBars(504, 150, 42);
        useSynthetic = true;
      }

      if (historicalBars.length < 100) {
        return formatToolResult({
          error: `Insufficient historical data: only ${historicalBars.length} bars available (need at least 100).`,
        }, []);
      }

      // 4. Get current quote
      onProgress?.('Fetching quote...');
      let quote: { symbol: string; price: number; change: number; changePercent: number; dayHigh: number; dayLow: number; volume: number; marketTime: number };
      try {
        quote = await fetchQuote(symbol);
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
      }

      // 5. Compute technical indicators
      onProgress?.('Computing technical indicators...');
      const indicators = computeIndicators(historicalBars, market);

      // 6. Load strategy config
      const strategy = loadStrategyConfig();

      // 7. Extract training matrix
      const { X, y } = extractTrainingMatrix(indicators);
      if (X.length < strategy.training.windowSize) {
        return formatToolResult({
          error: `Insufficient training samples: ${X.length} valid rows (need at least ${strategy.training.windowSize}). Try a stock with more trading history.`,
        }, []);
      }

      // 8. Train XGBoost
      onProgress?.('Training XGBoost prediction model...');
      let modelOutput;
      try {
        modelOutput = await trainXGBoost(X, y, MODEL_FEATURE_NAMES, strategy.training);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return formatToolResult({ error: `Model training failed: ${msg}` }, []);
      }

      // 9. Run backtest
      onProgress?.('Running backtest simulation...');
      const backtestResult = runBacktest(
        indicators.closes.slice(indicators.validStartIndex),
        modelOutput.allPredictions,
        strategy.backtest,
      );

      // 9. Format output
      onProgress?.('Formatting analysis report...');
      const dataTime = useSynthetic
        ? new Date().toISOString()
        : new Date(intradayBars[0].timestamp * 1000).toISOString();

      const analysisOutput = {
        ticker: symbol,
        market,
        currentPrice: quote.price,
        dayChange: quote.change,
        dayChangePct: quote.changePercent,
        dayHigh: quote.dayHigh,
        dayLow: quote.dayLow,
        volume: quote.volume,
        dataTime,
        indicators,
        modelOutput,
        backtestResult,
        intradayInterval: interval,
      };

      let formatted = formatStockAnalysis(analysisOutput);

      // 10. Generate charts
      let plotDataUrls: Record<string, string> = {};
      try {
        onProgress?.('Generating charts...');
        const plotData = buildPlotData(analysisOutput);
        const resolved = await resolvePlotPlaceholders(formatted, plotData);
        formatted = resolved.text;
        plotDataUrls = Object.fromEntries(resolved.plots);
      } catch {
        // Chart generation failed — strip placeholders and continue
        formatted = stripPlotPlaceholders(formatted);
      }

      if (useSynthetic) {
        formatted = `⚠️  **注意：东方财富 API 暂时不可用，当前使用合成数据演示。**\n\n${formatted}`;
      }

      return formatToolResult(
        { data: formatted, plots: plotDataUrls },
        [`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`],
      );
    },
  });
}
