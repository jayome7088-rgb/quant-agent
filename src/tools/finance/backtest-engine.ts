// Trading simulation engine with position sizing, stop-loss, take-profit,
// and transaction cost simulation — pure TypeScript.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BacktestConfig {
  initialCapital: number;
  positionSizing: {
    light: number;
    medium: number;
    heavy: number;
  };
  signalThresholds: {
    light: number;
    medium: number;
    heavy: number;
  };
  stopLoss: number;
  takeProfit: number;
  commission: number;
  slippage: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 100000,
  positionSizing: {
    light: 0.10,
    medium: 0.25,
    heavy: 0.50,
  },
  signalThresholds: {
    light: 0.55,
    medium: 0.65,
    heavy: 0.80,
  },
  stopLoss: -0.05,
  takeProfit: 0.10,
  commission: 0.001,
  slippage: 0.0005,
};

export interface Trade {
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  direction: 'long';
  size: 'light' | 'medium' | 'heavy';
  positionAmount: number;
  pnl: number;
  pnlPct: number;
  exitReason: 'stop_loss' | 'take_profit' | 'signal_reverse' | 'end_of_period';
}

export interface BacktestResult {
  trades: Trade[];
  equityCurve: number[];
  metrics: {
    totalReturn: number;
    totalReturnPct: number;
    annualizedReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    totalTrades: number;
    totalCommission: number;
    totalSlippage: number;
    lightTrades: number;
    mediumTrades: number;
    heavyTrades: number;
  };
}

// ---------------------------------------------------------------------------
// Main backtest runner
// ---------------------------------------------------------------------------

export function runBacktest(
  prices: number[],
  probabilities: number[],
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestResult {
  const n = Math.min(prices.length, probabilities.length);
  if (n === 0) {
    return emptyResult();
  }

  const trades: Trade[] = [];
  const equityCurve: number[] = new Array(n).fill(config.initialCapital);

  let capital = config.initialCapital;
  let inPosition = false;
  let entryIndex = -1;
  let entryPrice = 0;
  let positionSize: 'light' | 'medium' | 'heavy' = 'light';
  let positionAmount = 0;
  let peakPrice = 0; // trailing high since entry (for stop-loss tracking)

  let totalCommission = 0;
  let totalSlippage = 0;

  for (let i = 0; i < n; i++) {
    const price = prices[i];
    const prob = probabilities[i];
    equityCurve[i] = capital;

    if (inPosition) {
      // Track peak price since entry
      if (price > peakPrice) peakPrice = price;

      const priceReturn = (price - entryPrice) / entryPrice;
      let shouldExit = false;
      let exitReason: Trade['exitReason'] = 'end_of_period';

      // Check stop-loss
      if (priceReturn <= config.stopLoss) {
        shouldExit = true;
        exitReason = 'stop_loss';
      }
      // Check take-profit
      else if (priceReturn >= config.takeProfit) {
        shouldExit = true;
        exitReason = 'take_profit';
      }
      // Check signal reverse
      else if (prob < 0.5) {
        shouldExit = true;
        exitReason = 'signal_reverse';
      }

      // End of data — close position at last bar
      if (i === n - 1 && !shouldExit) {
        shouldExit = true;
        exitReason = 'end_of_period';
      }

      if (shouldExit) {
        // Exit with slippage
        const exitSlippage = exitReason === 'stop_loss' ? price * (1 - config.slippage) : price * (1 - config.slippage);
        const exitPrice = exitSlippage;
        const grossPnl = (exitPrice - entryPrice) * (positionAmount / entryPrice);
        const exitCost = positionAmount * (config.commission + config.slippage);
        const pnl = grossPnl - exitCost;
        const pnlPct = pnl / (positionAmount);

        capital += positionAmount + pnl;
        totalCommission += positionAmount * config.commission * 2; // entry + exit
        totalSlippage += positionAmount * config.slippage * 2;

        trades.push({
          entryIndex,
          exitIndex: i,
          entryPrice,
          exitPrice,
          direction: 'long',
          size: positionSize,
          positionAmount: Math.round(positionAmount * 100) / 100,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 10000) / 10000,
          exitReason,
        });

        inPosition = false;
        entryIndex = -1;
        entryPrice = 0;
        positionAmount = 0;
        peakPrice = 0;
        equityCurve[i] = capital;
      }
    }

    // Enter position if not already in one
    if (!inPosition && i < n - 1) {
      const size = getPositionSize(prob, config.signalThresholds);
      if (size) {
        inPosition = true;
        positionSize = size;
        entryIndex = i;
        entryPrice = price * (1 + config.slippage); // entry with slippage
        const allocation = config.positionSizing[size];
        positionAmount = capital * allocation;
        const entryCost = positionAmount * (config.commission + config.slippage);
        totalCommission += positionAmount * config.commission;
        totalSlippage += positionAmount * config.slippage;
        capital -= positionAmount + entryCost;
        peakPrice = entryPrice;
        equityCurve[i] = capital;
      }
    }
  }

  return {
    trades,
    equityCurve,
    metrics: computeMetrics(trades, equityCurve, config, totalCommission, totalSlippage),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPositionSize(
  prob: number,
  thresholds: BacktestConfig['signalThresholds'],
): 'light' | 'medium' | 'heavy' | null {
  if (prob >= thresholds.heavy) return 'heavy';
  if (prob >= thresholds.medium) return 'medium';
  if (prob >= thresholds.light) return 'light';
  return null;
}

function computeMetrics(
  trades: Trade[],
  equityCurve: number[],
  config: BacktestConfig,
  totalCommission: number,
  totalSlippage: number,
): BacktestResult['metrics'] {
  const initialCapital = config.initialCapital;
  const finalCapital = equityCurve[equityCurve.length - 1] ?? initialCapital;
  const totalReturn = finalCapital - initialCapital;
  const totalReturnPct = (totalReturn / initialCapital) * 100;

  // Annualized return (252 trading days per year)
  const tradingDays = equityCurve.length;
  const years = tradingDays / 252;
  const annualizedReturn = years > 0 ? (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100 : 0;

  // Sharpe ratio (daily returns)
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1] > 0) {
      dailyReturns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
    }
  }
  const avgDailyReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdDailyReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDailyReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpeRatio = stdDailyReturn > 0 ? (avgDailyReturn / stdDailyReturn) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = equityCurve[0] ?? initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = peak - val;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  // Trade stats
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return {
    totalReturn: Math.round(totalReturn * 100) / 100,
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    annualizedReturn: Math.round(annualizedReturn * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    winRate: Math.round(winRate * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalTrades: trades.length,
    totalCommission: Math.round(totalCommission * 100) / 100,
    totalSlippage: Math.round(totalSlippage * 100) / 100,
    lightTrades: trades.filter((t) => t.size === 'light').length,
    mediumTrades: trades.filter((t) => t.size === 'medium').length,
    heavyTrades: trades.filter((t) => t.size === 'heavy').length,
  };
}

function emptyResult(): BacktestResult {
  return {
    trades: [],
    equityCurve: [],
    metrics: {
      totalReturn: 0,
      totalReturnPct: 0,
      annualizedReturn: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      totalTrades: 0,
      totalCommission: 0,
      totalSlippage: 0,
      lightTrades: 0,
      mediumTrades: 0,
      heavyTrades: 0,
    },
  };
}
