---
name: stock-analysis
description: >
  Performs comprehensive ML-based technical stock analysis using XGBoost prediction,
  rolling backtest, and structured output. Triggers when user asks about stock trends,
  buy/sell recommendations, trading signals, technical outlook, analyze a stock,
  or any stock ticker analysis (US, HK, China A-shares). Use this when user mentions
  specific ticker symbols (e.g. AAPL, 09868, 600000) and asks for price prediction,
  technical analysis, or trading advice.
---

# Stock Analysis Skill

## When to Use

Invoke this skill when the user asks about:
- Stock technical analysis, trend prediction, price outlook
- Buy/sell/hold recommendations
- Trading signals or entry/exit timing
- "Should I buy/sell X?"
- "Analyze X stock" or "What's the outlook for X?"
- Any Chinese A-share (6XXXXX, 0XXXXX, 3XXXXX), HK (0XXXX), or US stock ticker analysis request

## When NOT to Use

- DCF valuation or fundamental analysis → use the `dcf-valuation` skill
- Financial statement deep-dive → use `get_financials`
- SEC filing reading → use `read_filings`
- Market screening → use `stock_screener`
- News sentiment → use `get_market_data`

## Workflow

### Step 1: Invoke the stock_analyzer tool

Call `stock_analyzer` with:
- `ticker`: the stock symbol (e.g., `09868`, `AAPL`, `600000`)
- `interval` (optional): intraday interval, default `5m`

The tool handles ticker normalization, data fetching, indicator computation, model training, backtesting, and formatting automatically.

### Step 2: Present the results

Present the formatted output returned by the tool as-is. Add a brief introductory sentence contextualizing the analysis for the user's specific question.

### Step 3: Add disclaimers

The tool already includes the disclaimer at the end of its output. Do not remove it. You may add: "This analysis is based on historical data and technical indicators. Past performance does not guarantee future results."
