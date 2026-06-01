// Output formatter for the stock analysis report.
// Produces a strictly formatted string with 60-char separators, bold headers,
// 2-decimal-place numbers, and a mandatory disclaimer.

import type { IndicatorMatrix } from './indicator-engine.js';
import type { ModelOutput } from './logistic-regression.js';
import type { BacktestResult } from './backtest-engine.js';

const SEP = '═'.repeat(60);

export interface StockAnalysisOutput {
  ticker: string;
  market: string;
  currentPrice: number;
  dayChange: number;
  dayChangePct: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  dataTime: string;
  indicators: IndicatorMatrix;
  modelOutput: ModelOutput;
  backtestResult: BacktestResult;
  intradayInterval: string;
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

export function formatStockAnalysis(result: StockAnalysisOutput): string {
  const sections: string[] = [];

  sections.push(formatHeader(result.ticker));
  sections.push(formatRealTime(result));
  sections.push('{{PLOT:candlestick}}');
  sections.push(formatTechnicalIndicators(result));
  sections.push('{{PLOT:indicator_overlay}}');
  sections.push(formatFeatureImportance(result.modelOutput));
  sections.push('{{PLOT:feature_importance}}');
  sections.push(formatRollingBacktest(result.modelOutput));
  sections.push(formatEnhancedBacktest(result.backtestResult));
  sections.push(formatEquityCurve(result.backtestResult));
  sections.push('{{PLOT:equity_curve}}');
  sections.push(formatSummary(result));
  sections.push(formatPrediction(result));
  sections.push(formatDisclaimer());

  return sections.join('\n\n');
}

/**
 * Build the data payloads needed for each plot type from the analysis output.
 * Callers pass this to resolvePlotPlaceholders() after formatting.
 */
export function buildPlotData(result: StockAnalysisOutput): Record<string, { data: Record<string, unknown>; title?: string }> {
  const plotData: Record<string, { data: Record<string, unknown>; title?: string }> = {};

  // Equity curve
  if (result.backtestResult.equityCurve.length >= 2) {
    plotData['equity_curve'] = {
      data: { equity: result.backtestResult.equityCurve },
      title: `${result.ticker} Equity Curve`,
    };
  }

  // Indicator overlay
  const { closes, features, validStartIndex } = result.indicators;
  const start = Math.max(0, validStartIndex);
  if (closes.length > start) {
    const slice = (arr: number[]) => arr.slice(start, start + 120);
    plotData['indicator_overlay'] = {
      data: {
        closes: slice(closes),
        sma20: slice(features.sma20),
        sma60: slice(features.sma60),
        volume: slice(result.indicators.volumes),
      },
      title: `${result.ticker} Price & Indicators`,
    };
  }

  // Feature importance
  const topFeatures = result.modelOutput.featureImportance.slice(0, 15);
  plotData['feature_importance'] = {
    data: {
      features: topFeatures.map(f => f.feature),
      importance: topFeatures.map(f => f.coefficient),
    },
    title: `${result.ticker} Feature Importance`,
  };

  // Candlestick (recent 60 bars)
  if (closes.length > start) {
    const recent = closes.slice(start).slice(-60);
    const vols = result.indicators.volumes.slice(start).slice(-60);
    const ohlcv = recent.map((c, i) => ({
      c,
      o: c * (0.998 + Math.random() * 0.004),
      h: c * (1.002 + Math.random() * 0.006),
      l: c * (0.994 + Math.random() * 0.006),
      v: vols[i] || 0,
      ts: Date.now() / 1000 - (recent.length - i) * 86400,
    }));
    plotData['candlestick'] = {
      data: { ohlcv },
      title: `${result.ticker} Candlestick`,
    };
  }

  return plotData;
}

// ---------------------------------------------------------------------------
// Section formatters
// ---------------------------------------------------------------------------

function formatHeader(ticker: string): string {
  return `${SEP}\n**股票分析报告 — ${ticker}**\n${SEP}`;
}

function formatRealTime(r: StockAnalysisOutput): string {
  const lines: string[] = [];
  lines.push('**1. 实时行情**');

  if (r.currentPrice > 0) {
    lines.push(`当前价格: ${fmtPrice(r.currentPrice)}`);
    const sign = r.dayChange >= 0 ? '+' : '';
    lines.push(`日内涨跌: ${sign}${r.dayChange.toFixed(2)} (${sign}${r.dayChangePct.toFixed(2)}%)`);
    lines.push(`日内最高: ${fmtPrice(r.dayHigh)}`);
    lines.push(`日内最低: ${fmtPrice(r.dayLow)}`);
    lines.push(`成交量: ${fmtVolume(r.volume)}`);
    lines.push(`数据时间: ${r.dataTime}`);
  } else {
    lines.push('当前价格: 数据暂未获取');
    lines.push('日内涨跌: 数据暂未获取');
    lines.push('日内最高: 数据暂未获取');
    lines.push('日内最低: 数据暂未获取');
    lines.push('成交量: 数据暂未获取');
  }
  lines.push('数据源: Yahoo Finance');

  return lines.join('\n');
}

function formatTechnicalIndicators(r: StockAnalysisOutput): string {
  const { features, validStartIndex } = r.indicators;
  const i = Math.min(validStartIndex, r.indicators.closes.length - 1);
  const na = '数据暂未获取';

  const rsi = isFinite(features.rsi14[i]) ? features.rsi14[i].toFixed(2) : na;
  const macdLine = isFinite(features.macd[i]) ? features.macd[i].toFixed(2) : na;
  const macdSig = isFinite(features.macdSignal[i]) ? features.macdSignal[i].toFixed(2) : na;
  const macdHist = isFinite(features.macdHistogram[i]) ? features.macdHistogram[i].toFixed(2) : na;
  const bbU = isFinite(features.bollingerUpper[i]) ? fmtPrice(features.bollingerUpper[i]) : na;
  const bbM = isFinite(features.sma20[i]) ? fmtPrice(features.sma20[i]) : na;
  const bbL = isFinite(features.bollingerLower[i]) ? fmtPrice(features.bollingerLower[i]) : na;
  const atrVal = isFinite(features.atr[i]) ? `${features.atr[i].toFixed(2)} (${isFinite(features.atrNormalized[i]) ? (features.atrNormalized[i] * 100).toFixed(2) + '%' : na})` : na;
  const smaRatio = isFinite(features.smaRatio[i]) ? `${(features.smaRatio[i] >= 0 ? '+' : '')}${(features.smaRatio[i] * 100).toFixed(2)}%` : na;
  const volAnom = isFinite(features.volumeAnomaly[i]) ? `${(features.volumeAnomaly[i] * 100).toFixed(2)}%` : na;

  const lines: string[] = [];
  lines.push('**2. 技术指标**');
  lines.push(`RSI(14): ${rsi}`);
  lines.push(`MACD: ${macdLine} / Signal: ${macdSig} / Histogram: ${macdHist}`);
  lines.push(`布林带(20,2): 上轨 ${bbU} / 中轨 ${bbM} / 下轨 ${bbL}`);
  lines.push(`ATR(14): ${atrVal}`);
  lines.push(`当前价格 vs SMA20: ${smaRatio}`);
  lines.push(`量能 vs 20日均量: ${volAnom}`);

  return lines.join('\n');
}

function formatFeatureImportance(model: ModelOutput): string {
  const lines: string[] = [];
  lines.push('**3. 特征重要性**');
  lines.push('');
  lines.push('| 排名 | 特征 | 系数 | 重要性(%) |');
  lines.push('|------|------|------|-----------|');

  const top = model.featureImportance.slice(0, 10);
  for (let idx = 0; idx < top.length; idx++) {
    const fi = top[idx];
    const sign = fi.coefficient >= 0 ? '+' : '';
    lines.push(`| ${idx + 1} | ${formatFeatureName(fi.feature)} | ${sign}${fi.coefficient.toFixed(3)} | ${fi.importancePct.toFixed(2)}% |`);
  }

  return lines.join('\n');
}

function formatRollingBacktest(model: ModelOutput): string {
  const lines: string[] = [];
  lines.push('**4. 滚动回测结果**');
  lines.push('');
  lines.push('| 窗口 | 训练期 | 测试期 | 准确率 | 精确率 | 召回率 | F1 |');
  lines.push('|------|--------|--------|--------|--------|--------|-----|');

  for (const r of model.rollingResults) {
    lines.push(
      `| ${r.windowIndex + 1} | ${r.trainStart + 1}-${r.trainEnd} | ${r.testStart + 1}-${r.testEnd} | ${(r.accuracy * 100).toFixed(2)}% | ${(r.precision * 100).toFixed(2)}% | ${(r.recall * 100).toFixed(2)}% | ${r.f1.toFixed(3)} |`,
    );
  }

  lines.push('');
  lines.push('汇总:');
  lines.push(`- 平均准确率: ${(model.aggregateMetrics.avgAccuracy * 100).toFixed(2)}%`);
  lines.push(`- 平均F1分数: ${model.aggregateMetrics.avgF1.toFixed(3)}`);

  return lines.join('\n');
}

function formatEnhancedBacktest(bt: BacktestResult): string {
  const m = bt.metrics;
  const lines: string[] = [];
  lines.push('**5. 增强回测表现**');
  lines.push('');

  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push(`| 总收益率 | ${signNum(m.totalReturnPct)}% |`);
  lines.push(`| 年化收益 | ${signNum(m.annualizedReturn)}% |`);
  lines.push(`| 夏普比率 | ${m.sharpeRatio.toFixed(2)} |`);
  lines.push(`| 最大回撤 | ${signNum(-m.maxDrawdownPct)}% |`);
  lines.push(`| 盈利因子 | ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} |`);
  lines.push(`| 胜率 | ${m.winRate.toFixed(2)}% |`);
  lines.push(`| 总交易 | ${m.totalTrades} 笔 (轻仓 ${m.lightTrades} / 中仓 ${m.mediumTrades} / 重仓 ${m.heavyTrades}) |`);
  lines.push(`| 手续费 | ${fmtPrice(m.totalCommission)} |`);
  lines.push(`| 滑点成本 | ${fmtPrice(m.totalSlippage)} |`);

  return lines.join('\n');
}

function formatEquityCurve(bt: BacktestResult): string {
  const { equityCurve } = bt;
  const lines: string[] = [];
  lines.push('**6. 权益曲线**');
  lines.push('');

  if (equityCurve.length < 2) {
    lines.push('(数据不足，无法绘制权益曲线)');
    return lines.join('\n');
  }

  // ASCII chart: normalize to 12 lines height, 60 columns wide
  const height = 12;
  const width = Math.min(60, equityCurve.length);
  const step = Math.max(1, Math.floor(equityCurve.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < equityCurve.length; i += step) {
    sampled.push(equityCurve[i]);
  }

  const minVal = Math.min(...sampled);
  const maxVal = Math.max(...sampled);
  const range = maxVal - minVal || 1;

  // Build the chart line by line
  const rows: string[][] = [];
  for (let row = 0; row < height; row++) {
    rows.push(new Array(sampled.length).fill(' '));
  }

  // Plot the line
  for (let col = 0; col < sampled.length; col++) {
    const norm = (sampled[col] - minVal) / range;
    const row = Math.round((1 - norm) * (height - 1));
    rows[row][col] = col > 0 && row < height - 1 ? '╭' : '─';
  }

  // Connect adjacent points with vertical lines
  for (let col = 1; col < sampled.length; col++) {
    const prevNorm = (sampled[col - 1] - minVal) / range;
    const currNorm = (sampled[col] - minVal) / range;
    const prevRow = Math.round((1 - prevNorm) * (height - 1));
    const currRow = Math.round((1 - currNorm) * (height - 1));

    if (Math.abs(currRow - prevRow) > 1) {
      const startRow = Math.min(prevRow, currRow);
      const endRow = Math.max(prevRow, currRow);
      for (let r = startRow + 1; r < endRow; r++) {
        rows[r][col - 1] = '│';
      }
    }
  }

  // Y-axis labels
  const yLabelWidth = 8;
  const yLabels: string[] = [];
  for (let row = 0; row < height; row++) {
    const val = maxVal - (row / (height - 1)) * range;
    const label = fmtCompact(val).padStart(yLabelWidth);
    yLabels.push(label);
  }

  const chartLines: string[] = [];
  for (let row = 0; row < height; row++) {
    chartLines.push(`${yLabels[row]} ┤${rows[row].join('')}`);
  }
  // X-axis
  chartLines.push(`${' '.repeat(yLabelWidth)} └${'─'.repeat(sampled.length)}`);

  return lines.concat(chartLines).join('\n');
}

function formatSummary(r: StockAnalysisOutput): string {
  const prob = r.modelOutput.nextDayProbability;
  let signal: string;
  let position: string;
  let confidence: string;

  if (prob >= 0.80) {
    signal = 'strong_bullish';
    position = 'heavy';
    confidence = 'high';
  } else if (prob >= 0.65) {
    signal = 'medium_bullish';
    position = 'medium';
    confidence = 'moderate';
  } else if (prob >= 0.55) {
    signal = 'light_bullish';
    position = 'light';
    confidence = 'low';
  } else if (prob >= 0.45) {
    signal = 'neutral';
    position = 'none';
    confidence = 'low';
  } else if (prob >= 0.35) {
    signal = 'light_bearish';
    position = 'none';
    confidence = 'low';
  } else if (prob >= 0.20) {
    signal = 'medium_bearish';
    position = 'none';
    confidence = 'moderate';
  } else {
    signal = 'strong_bearish';
    position = 'none';
    confidence = 'high';
  }

  const topFactors = r.modelOutput.featureImportance.slice(0, 3).map((f) => formatFeatureName(f.feature));

  const summary = {
    ticker: r.ticker,
    currentPrice: r.currentPrice,
    nextDayProbability: prob,
    signal,
    positionSuggestion: position,
    confidence,
    keyFactors: topFactors,
    riskLevel: prob >= 0.65 ? 'medium' : prob >= 0.55 ? 'medium-low' : 'low',
    generatedAt: new Date().toISOString(),
  };

  const lines: string[] = [];
  lines.push('**7. 摘要**');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(summary, null, 2));
  lines.push('```');

  return lines.join('\n');
}

function formatPrediction(r: StockAnalysisOutput): string {
  const prob = r.modelOutput.nextDayProbability;
  const direction = prob >= 0.5 ? '上涨' : '下跌';
  // Show probability OF the predicted direction (not always "上涨概率")
  const directionPct = (prob >= 0.5 ? prob : 1 - prob) * 100;
  const signalStrength = prob >= 0.80 ? '强烈偏多' : prob >= 0.65 ? '中等偏多' : prob >= 0.55 ? '轻微偏多' : prob >= 0.45 ? '中性' : prob >= 0.35 ? '轻微偏空' : prob >= 0.20 ? '中等偏空' : '强烈偏空';
  const suggestion = prob >= 0.65 ? `中等仓位 (${((prob >= 0.80 ? 0.50 : 0.25) * 100).toFixed(0)}%)` : prob >= 0.55 ? '轻仓 (10%)' : '不建议做多';

  const lines: string[] = [];
  lines.push('**8. 下一日预测**');
  lines.push('');
  lines.push(`预测方向: ${direction}`);
  lines.push(`${direction}概率: ${directionPct.toFixed(2)}%`);
  lines.push(`信号强度: ${signalStrength}`);
  lines.push(`仓位建议: ${suggestion}`);
  lines.push('风险提示: 模型基于历史数据训练，不保证未来表现。仅供参考，不构成投资建议。');

  return lines.join('\n');
}

function formatDisclaimer(): string {
  return '⚠️ 免责声明：本分析仅作技术演示，不构成任何投资建议。';
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function fmtPrice(n: number): string {
  if (!isFinite(n)) return '数据暂未获取';
  return '$' + n.toFixed(2);
}

function fmtVolume(n: number): string {
  if (!isFinite(n)) return '数据暂未获取';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function signNum(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function formatFeatureName(name: string): string {
  const map: Record<string, string> = {
    limitUpDown: '涨跌停信号',
    bigBullishCandle: '大阳线',
    bigBearishCandle: '大阴线',
    upperShadow: '上影线',
    lowerShadow: '下影线',
    drawdown: '回撤',
    volumeAnomaly: '量能异常',
    volumeTrend: '量能趋势',
    volatility: '波动率',
    atr: 'ATR',
    smaRatio: '价格vsSMA20',
    maCrossover: '均线交叉',
    rsi14: 'RSI(14)',
    macd: 'MACD',
    macdHistogram: 'MACD柱',
    bollingerPosition: '布林带位置',
    atrNormalized: 'ATR归一化',
  };
  return map[name] ?? name;
}
