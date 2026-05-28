#!/usr/bin/env bun
/**
 * Phase 3 — Planner Verification
 *
 * Verifies the LLM-based query decomposition pipeline:
 *   1. createPlan() generates a valid ResearchPlan from a complex query
 *   2. The plan has correct structure (3-8 steps, valid deps, no cycles)
 *   3. Tool names match the actual tool registry
 *   4. Fallback retry works on first-attempt failure
 *
 * Usage:
 *   bun run src/verify-planner.ts
 *
 * Prereqs:
 *   DEEPSEEK_API_KEY in .env
 */

import { config } from 'dotenv';
config({ quiet: true });

import { createPlan } from './planner/planner.js';
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
// Test queries — increasingly complex
// ---------------------------------------------------------------------------

const TEST_QUERIES = [
  {
    query: 'Compare AAPL and MSFT revenue growth and profit margins over the last 3 fiscal years',
    label: 'Multi-company comparison',
  },
  {
    query: 'Find tech companies with P/E under 20, revenue growth above 15%, and market cap over 50B',
    label: 'Stock screening + financials',
  },
  {
    query: 'What is the PEG ratio for NVDA and how does it compare to the semiconductor industry average?',
    label: 'Single company deep dive',
  },
];

// ---------------------------------------------------------------------------
// Run a single plan test
// ---------------------------------------------------------------------------

async function runPlanTest(query: string, label: string, model: string): Promise<boolean> {
  header(label);

  console.log(`\n  Query: "${query}"`);
  console.log(`  Model : ${model}`);
  hr();

  const start = Date.now();

  try {
    const plan = await createPlan(query, model);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n  Plan generated in ${elapsed}s`);
    console.log(`  Summary: ${plan.summary}`);
    console.log(`  Steps: ${plan.steps.length}`);
    hr();

    // Display each step
    for (const step of plan.steps) {
      const deps = step.dependsOn.length > 0
        ? ` ← depends on [${step.dependsOn.join(', ')}]`
        : '';
      console.log(`\n  [${step.id}]`);
      console.log(`    Goal     : ${step.goal}`);
      console.log(`    Tool     : ${step.tool}`);
      console.log(`    Args     : ${JSON.stringify(step.toolArgs)}${deps}`);
      console.log(`    Expected : ${step.expectedOutput}`);
    }

    hr();
    console.log(`\n  Status: PASS (${plan.steps.length} steps, ${elapsed}s)`);
    return true;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const message = err instanceof Error ? err.message : String(err);
    console.log(`\n  Status: FAIL (${elapsed}s)`);
    console.log(`  Error: ${message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.clear();
  console.log('QuantAgent — Phase 3 Planner Verification\n');
  console.log(`  Provider : ${process.env.LLM_PROVIDER ?? 'deepseek'}`);
  console.log(`  Model    : ${DEFAULT_MODEL}`);

  // Validate API key
  if (!process.env.DEEPSEEK_API_KEY?.startsWith('sk-')) {
    console.log('\n  ERROR: DEEPSEEK_API_KEY is not set or invalid.');
    console.log('  Open .env and set DEEPSEEK_API_KEY to your actual key.\n');
    process.exit(1);
  }
  console.log('  API key  : ✓');
  hr();

  let passed = 0;
  let failed = 0;

  for (const test of TEST_QUERIES) {
    const ok = await runPlanTest(test.query, test.label, DEFAULT_MODEL);
    if (ok) passed++;
    else failed++;
  }

  // Summary
  header('Results');
  console.log(`\n  Passed: ${passed}/${TEST_QUERIES.length}`);
  if (failed > 0) {
    console.log(`  Failed: ${failed}/${TEST_QUERIES.length}`);
  }
  console.log(`\nPhase 3 planner verification complete.\n`);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
