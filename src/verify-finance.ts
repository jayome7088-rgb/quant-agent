#!/usr/bin/env bun
/**
 * Phase 4 — Financial Tools Verification
 *
 * Verifies all 4 meta-tools against the real Financial Datasets API:
 *   1. get_financials — company financials, metrics, ratios
 *   2. get_market_data — prices, news, insider trades
 *   3. read_filings — SEC filing content retrieval
 *   4. stock_screener — screening by financial criteria
 *
 * Also validates the data flow: router LLM → sub-tool selection → API call → formatter.
 *
 * Usage:
 *   bun run src/verify-finance.ts
 *
 * Prereqs:
 *   DEEPSEEK_API_KEY in .env (for router LLM)
 *   FINANCIAL_DATASETS_API_KEY in .env (for financial data)
 */

import { config } from 'dotenv';
config({ quiet: true });

import { createGetFinancials } from './tools/finance/get-financials.js';
import { createGetMarketData } from './tools/finance/get-market-data.js';
import { createReadFilings } from './tools/finance/read-filings.js';
import { createScreenStocks } from './tools/finance/screen-stocks.js';
import { DEFAULT_MODEL } from './model/llm.js';

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const W = process.stdout.columns || 60;

function hr(char = '─'): void {
  console.log(char.repeat(W));
}

function header(title: string): void {
  console.log(`\n${'═'.repeat(W)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(W));
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  pass: boolean;
  durationMs: number;
  steps: number;
  error?: string;
  preview: string;
}

async function runTest(
  name: string,
  fn: () => Promise<string>,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const output = await fn();
    const elapsed = Date.now() - start;
    return {
      name,
      pass: true,
      durationMs: elapsed,
      steps: 0,
      preview: output.slice(0, 500),
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      pass: false,
      durationMs: elapsed,
      steps: 0,
      error: message,
      preview: '',
    };
  }
}

function printResult(result: TestResult, index: number, hasFinanceKey: boolean): void {
  const icon = result.pass ? '✓' : '✗';
  const time = (result.durationMs / 1000).toFixed(1);
  console.log(`\n  ${icon} Test ${index}: ${result.name} (${time}s)`);
  if (result.pass) {
    const preview = result.preview.length > 300
      ? result.preview.slice(0, 300) + '...'
      : result.preview;
    console.log(`  ${preview.split('\n').map(l => '    ' + l).join('\n')}`);
  } else {
    const isKeyError = !hasFinanceKey && result.error?.includes('401');
    const label = isKeyError ? '(expected — missing API key)' : '';
    console.log(`  Error: ${result.error} ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Tool instances (created once with default model)
// ---------------------------------------------------------------------------

const getFinancials = createGetFinancials(DEFAULT_MODEL);
const getMarketData = createGetMarketData(DEFAULT_MODEL);
const readFilings = createReadFilings(DEFAULT_MODEL);
const screenStocks = createScreenStocks(DEFAULT_MODEL);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.clear();
  console.log('Dexter Pro — Phase 4 Financial Tools Verification\n');
  console.log(`  Router model : ${DEFAULT_MODEL}`);
  console.log(`  Data source  : Financial Datasets API`);

  // Validate API keys
  if (!process.env.DEEPSEEK_API_KEY?.startsWith('sk-')) {
    console.log('\n  ERROR: DEEPSEEK_API_KEY is not set or invalid.\n');
    process.exit(1);
  }

  const hasFinanceKey = !!process.env.FINANCIAL_DATASETS_API_KEY;
  if (!hasFinanceKey) {
    console.log('  WARNING: FINANCIAL_DATASETS_API_KEY is not set.');
    console.log('  Get a free key at https://financialdatasets.ai and add it to your .env file.');
    console.log('  Tests will still run to verify router LLM logic, but data fetches will fail.\n');
  } else {
    console.log('  API keys   : ✓ (DeepSeek + Financial Datasets)');
  }
  hr();

  const results: TestResult[] = [];

  // -------------------------------------------------------------------
  // Test 1: get_financials — key metrics for a single company
  // -------------------------------------------------------------------
  header('Test 1 — get_financials (key metrics)');
  const r1 = await runTest('AAPL key metrics', async () => {
    return getFinancials.invoke({
      query: "What is Apple's current P/E ratio, market cap, revenue growth, and net margin?",
    });
  });
  results.push(r1);
  printResult(r1, 1, hasFinanceKey);

  // -------------------------------------------------------------------
  // Test 2: get_financials — financial statements
  // -------------------------------------------------------------------
  header('Test 2 — get_financials (income statement)');
  const r2 = await runTest('MSFT income statement', async () => {
    return getFinancials.invoke({
      query: "Get Microsoft's annual revenue and net income for the last 3 fiscal years",
    });
  });
  results.push(r2);
  printResult(r2, 2, hasFinanceKey);

  // -------------------------------------------------------------------
  // Test 3: get_market_data — stock prices
  // -------------------------------------------------------------------
  header('Test 3 — get_market_data (stock prices)');
  const r3 = await runTest('NVDA stock price', async () => {
    return getMarketData.invoke({
      query: "What's the current stock price and market cap for NVDA?",
    });
  });
  results.push(r3);
  printResult(r3, 3, hasFinanceKey);

  // -------------------------------------------------------------------
  // Test 4: get_market_data — news
  // -------------------------------------------------------------------
  header('Test 4 — get_market_data (company news)');
  const r4 = await runTest('TSLA recent news', async () => {
    return getMarketData.invoke({
      query: 'Show me the latest news headlines for TSLA',
    });
  });
  results.push(r4);
  printResult(r4, 4, hasFinanceKey);

  // -------------------------------------------------------------------
  // Test 5: stock_screener
  // -------------------------------------------------------------------
  header('Test 5 — stock_screener');
  const r5 = await runTest('Tech screener', async () => {
    return screenStocks.invoke({
      query: 'Find large cap tech stocks with P/E under 30 and revenue growth above 10%',
    });
  });
  results.push(r5);
  printResult(r5, 5, hasFinanceKey);

  // -------------------------------------------------------------------
  // Test 6: stock_screener — sector filter
  // -------------------------------------------------------------------
  header('Test 6 — stock_screener (sector filter)');
  const r6 = await runTest('Healthcare screener', async () => {
    return screenStocks.invoke({
      query: 'Find healthcare sector stocks with market cap above 10B and ROE above 15%',
    });
  });
  results.push(r6);
  printResult(r6, 6, hasFinanceKey);

  // -------------------------------------------------------------------
  // Test 7: read_filings — 10-K content
  // -------------------------------------------------------------------
  header('Test 7 — read_filings (10-K risk factors)');
  const r7 = await runTest('AAPL 10-K risk factors', async () => {
    return readFilings.invoke({
      query: "Show me Apple's risk factors from their latest 10-K filing",
    });
  });
  results.push(r7);
  printResult(r7, 7, hasFinanceKey);

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  header('Results');
  const passed = results.filter(r => r.pass).length;
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log(`\n  Passed : ${passed}/${results.length}`);
  console.log(`  Time   : ${(totalTime / 1000).toFixed(1)}s total`);

  const failed = results.filter(r => !r.pass);
  if (failed.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  console.log(`\nPhase 4 financial tools verification complete.\n`);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
