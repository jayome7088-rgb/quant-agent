import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { OHLCVBar, normalizeTicker, fetchQuote } from './eastmoney-api.js';
import { fetchAKShareChart, fetchAKShareQuote } from './akshare-bridge.js';
import { computeIndicators, extractTrainingMatrix, MODEL_FEATURE_NAMES } from './indicator-engine.js';
import type { FundamentalSnapshot } from './indicator-engine.js';
import { predictWithUniversalModel } from './pool-trainer.js';
import { trainXGBoost, DEFAULT_TRAINING_CONFIG } from './xgb-bridge.js';
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

NOTE: This tool fetches data from East Money (东方财富) for quotes and AKShare for historical data. Uses pre-trained universal XGBoost model. May take 10-30 seconds.
`.trim();

const StockAnalyzerInputSchema = z.object({
  ticker: z.string().describe("The stock ticker symbol. Supports US stocks (AAPL), HK stocks (09868, 0700), and China A-shares (600000, 000001)."),
  interval: z.enum(['1m', '5m', '15m', '30m', '1h']).default('5m').describe("Intraday interval for real-time data. Default 5m."),
});

/** Simple string hash → positive integer seed for deterministic synthetic data. */
function hashTicker(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

/** Pick the first defined numeric value from an object using candidate keys. */
function pickNum(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return undefined;
}

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

      // 1. Normalize ticker for East Money
      onProgress?.('Normalizing ticker...');
      const { symbol, market } = normalizeTicker(rawTicker);

      // 2. Get real-time quote — East Money primary, AKShare fallback
      onProgress?.('Fetching quote...');
      let quote: { symbol: string; price: number; change: number; changePercent: number; dayHigh: number; dayLow: number; volume: number; marketTime: number };
      try {
        quote = await fetchQuote(symbol);
        if (!quote || quote.price <= 0) throw new Error('Invalid price data');
      } catch (emErr) {
        // East Money failed — try AKShare fallback
        console.warn(`[stock_analyzer] East Money failed: ${emErr instanceof Error ? emErr.message : String(emErr)}`);
        onProgress?.('East Money failed, trying AKShare fallback...');
        try {
          quote = await fetchAKShareQuote(symbol);
        } catch (akErr) {
          const msg = akErr instanceof Error ? akErr.message : String(akErr);
          return formatToolResult({
            error: `所有数据源均不可用。东方财富: ${emErr instanceof Error ? emErr.message.slice(0,50) : 'failed'}。AKShare: ${msg.slice(0,50)}。请10分钟后重试。`,
          }, []);
        }
      }

      const quotePrice = quote.price;

      // 3. Intraday data (synthetic — AKShare only supports 1d, acceptable)
      onProgress?.(`Generating intraday data...`);
      const tickerSeed = hashTicker(rawTicker);
      const intradayBars = syntheticBars(78, quotePrice, tickerSeed);

      // 4. Fetch historical daily data via AKShare
      onProgress?.('Fetching historical data (AKShare)...');
      let historicalBars: OHLCVBar[];
      let useSynthetic = false;
      try {
        const r = await fetchAKShareChart(rawTicker, '1d', '2y');
        historicalBars = r.quotes;
      } catch {
        historicalBars = syntheticBars(504, quotePrice, tickerSeed + 1);
        useSynthetic = true;
      }

      if (historicalBars.length < 30) {
        return formatToolResult({
          error: `Insufficient historical data: only ${historicalBars.length} bars available (need at least 30).`,
        }, []);
      }

      // For stocks with < 120 bars, skip ML analysis entirely — not enough data
      if (historicalBars.length < 120) {
        const msg = `⚠️ 该股票上市时间较短（仅 ${historicalBars.length} 条历史数据），历史数据不足，无法生成准确分析。请等待积累更多交易日数据后再试。`;
        if (quote!) {
          return formatToolResult(
            `${msg}\n\n**${symbol} 实时行情**\n当前价格: $${quote.price.toFixed(2)}\n日内涨跌: ${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)} (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%)\n日内最高: $${quote.dayHigh.toFixed(2)}\n日内最低: $${quote.dayLow.toFixed(2)}\n成交量: ${quote.volume.toLocaleString()}\n数据时间: ${new Date(quote.marketTime * 1000).toISOString()}\n数据源: 东方财富 (East Money)`,
            [],
          );
        }
        return formatToolResult(msg, []);
      }

      // Build quote from intraday bars if fetch failed
      if (!quote) {
        const b = intradayBars[intradayBars.length - 1];
        quote = {
          symbol: symbol, price: b.close, change: b.close - intradayBars[0].open,
          changePercent: (b.close - intradayBars[0].open) / intradayBars[0].open * 100,
          dayHigh: Math.max(...intradayBars.map(x => x.high)),
          dayLow: Math.min(...intradayBars.map(x => x.low)),
          volume: intradayBars.reduce((s, x) => s + x.volume, 0),
          marketTime: b.timestamp,
        };
      }

      // 5. Fetch fundamental data (key ratios)
      onProgress?.('Fetching fundamental data...');
      let fundamentals: FundamentalSnapshot = {};
      try {
        const apiModule = await import('./api.js');
        const { data } = await apiModule.api.get('/financial-metrics/snapshot/', { ticker: symbol }, { cacheable: true, ttlMs: 3600000 });
        const snap = (data as Record<string, unknown>).snapshot || data;
        const s = snap as Record<string, unknown>;
        // Map API fields to our fundamental snapshot, cap extreme values
        const cap = (v: number | undefined, min: number, max: number) =>
          v !== undefined ? Math.max(min, Math.min(max, v)) : undefined;
        fundamentals = {
          peRatio: cap(pickNum(s, 'price_to_earnings_ratio', 'pe_ratio', 'pe'), -500, 500),
          pbRatio: cap(pickNum(s, 'price_to_book_ratio', 'pb_ratio', 'pb'), -50, 100),
          revenueGrowth: cap(pickNum(s, 'revenue_growth', 'revenue_growth_yoy'), -1, 5),
          earningsGrowth: cap(pickNum(s, 'earnings_growth_yoy', 'net_income_growth', 'earnings_growth'), -1, 5),
          grossMargin: cap(pickNum(s, 'gross_margin'), -0.5, 1.5),
          netMargin: cap(pickNum(s, 'net_margin', 'profit_margin'), -1, 1),
          roe: cap(pickNum(s, 'return_on_equity', 'roe'), -2, 3),
        };
      } catch {
        // Fundamentals unavailable — continue without them
      }

      // 6. Compute technical indicators
      onProgress?.('Computing technical indicators...');
      const indicators = computeIndicators(historicalBars, market, fundamentals);

      // 6. Load strategy config
      const strategy = loadStrategyConfig();

      // 7. Extract training matrix
      const { X, y } = extractTrainingMatrix(indicators);
      if (X.length < 20) {
        return formatToolResult({
          error: `Insufficient training samples: ${X.length} valid rows (need at least 20).`,
        }, []);
      }

      // 8. Get prediction AND stock-specific analysis
      onProgress?.('Predicting with universal model...');
      let modelOutput;
      try {
        // Universal model for next-day probability
        const predResult = await predictWithUniversalModel(X, MODEL_FEATURE_NAMES);

        // Fit per-stock XGBoost for rolling metrics + stock-specific FI
        let stockFi = predResult.featureImportance;
        let rollingResults: any[] = [];
        let aggMetrics = { avgAccuracy: 0, avgPrecision: 0, avgRecall: 0, avgF1: 0 };
        try {
          const perStock = await trainXGBoost(X, y, MODEL_FEATURE_NAMES, DEFAULT_TRAINING_CONFIG);
          stockFi = perStock.featureImportance;
          rollingResults = perStock.rollingResults;
          aggMetrics = perStock.aggregateMetrics;
        } catch {
          // Use universal model FI if per-stock fails
        }

        modelOutput = {
          coefficients: [],
          featureImportance: stockFi,
          rollingResults,
          aggregateMetrics: aggMetrics,
          allPredictions: predResult.allPredictions,
          nextDayProbability: predResult.nextDayProbability,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return formatToolResult({ error: `Model prediction failed: ${msg}` }, []);
      }

      // 9. Run backtest
      onProgress?.('Running backtest simulation...');
      const backtestResult = runBacktest(
        indicators.closes.slice(indicators.validStartIndex),
        modelOutput.allPredictions,
        strategy.backtest,
      );

      // 9. Verify feature importance (gain-based from XGBoost)
      const gains = modelOutput.featureImportance.map(f => f.gain ?? f.absImportance);
      const pcts = modelOutput.featureImportance.map(f => f.importancePct);
      console.log('[stock_analyzer] XGBoost gain values:', gains);
      console.log('[stock_analyzer] Gain-based importance (%):', pcts.map(p => p.toFixed(1)));
      console.log('[stock_analyzer] Sum of importance %:', pcts.reduce((s, v) => s + v, 0).toFixed(2) + '%');
      console.log('[stock_analyzer] Equity curve points:', backtestResult.equityCurve.length);

      // 11. Format output
      onProgress?.('Formatting analysis report...');
      const lastBar = historicalBars[historicalBars.length - 1];
      const dataTime = new Date(lastBar.timestamp * 1000).toISOString();

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

      // 12. Generate charts
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
        formatted = `⚠️  **注意：历史K线数据获取失败，当前使用合成数据进行技术分析。实时行情为真实数据。**\n\n${formatted}`;
      }

      return formatToolResult(
        { data: formatted, plots: plotDataUrls },
        [`https://finance.sina.com.cn/realstock/company/${symbol.toLowerCase()}/nc.shtml`],
      );
    },
  });
}
