#!/usr/bin/env bun
/**
 * Phase 5 — Agent Executor + Self-Validation Loop Verification
 *
 * Verifies the full plan-aware agent loop:
 *   1. Complex queries trigger planner decomposition
 *   2. Plan steps are executed and tracked
 *   3. Self-validation fires before final answer
 *   4. Both conversational and complex queries work
 *
 * Usage:
 *   bun run src/verify-phase5.ts
 *
 * Prereqs:
 *   DEEPSEEK_API_KEY in .env
 *   FINANCIAL_DATASETS_API_KEY in .env (optional)
 */

import { config } from 'dotenv';
config({ quiet: true });

import { Agent } from './agent/agent.js';
import type { AgentEvent } from './agent/types.js';

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
// Run a single test query
// ---------------------------------------------------------------------------

interface RunResult {
  label: string;
  query: string;
  pass: boolean;
  planStarted: boolean;
  planSteps: number;
  planCompleted: boolean;
  selfValidated: boolean;
  iterations: number;
  durationMs: number;
  toolsUsed: number;
  error?: string;
}

async function runQuery(query: string, label: string): Promise<RunResult> {
  const start = Date.now();
  const agent = await Agent.create({ usePlanner: true });

  let planStarted = false;
  let planSteps = 0;
  let planCompleted = false;
  let selfValidated = false;
  let iterations = 0;
  let toolsUsed = 0;
  let finalAnswer = '';
  let error: string | undefined;

  for await (const event of agent.run(query)) {
    switch (event.type) {
      case 'plan_start':
        planStarted = true;
        break;

      case 'plan_step':
        planSteps++;
        break;

      case 'plan_complete':
        planCompleted = true;
        break;

      case 'self_validation':
        selfValidated = true;
        break;

      case 'tool_start':
        toolsUsed++;
        break;

      case 'done':
        iterations = event.iterations;
        finalAnswer = event.answer;
        if (event.answer?.startsWith('Error:')) {
          error = event.answer;
        }
        break;
    }
  }

  const durationMs = Date.now() - start;
  const pass = !error && finalAnswer.length > 50;

  return {
    label,
    query,
    pass,
    planStarted,
    planSteps,
    planCompleted,
    selfValidated,
    iterations,
    durationMs,
    toolsUsed,
    error,
  };
}

function printResult(r: RunResult, index: number): void {
  const icon = r.pass ? '✓' : '✗';
  const time = (r.durationMs / 1000).toFixed(1);
  console.log(`\n  ${icon} Test ${index}: ${r.label} (${time}s)`);
  console.log(`    Query: "${r.query}"`);
  console.log(`    Plan    : ${r.planStarted ? `✓ (${r.planSteps} steps, ${r.planCompleted ? 'complete' : 'incomplete'})` : 'not triggered'}`);
  console.log(`    Validate: ${r.selfValidated ? '✓' : '—'}`);
  console.log(`    Tools   : ${r.toolsUsed} calls`);
  console.log(`    Iters   : ${r.iterations}`);
  if (r.error) {
    console.log(`    Error   : ${r.error.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.clear();
  console.log('QuantAgent — Phase 5 Agent Executor + Self-Validation Verification\n');

  if (!process.env.DEEPSEEK_API_KEY?.startsWith('sk-')) {
    console.log('  ERROR: DEEPSEEK_API_KEY is not set or invalid.\n');
    process.exit(1);
  }
  console.log('  API key    : ✓');
  console.log('  Planner    : enabled for complex queries');
  hr();

  const results: RunResult[] = [];

  // Test 1 — Complex: should trigger planner
  header('Test 1 — Complex query (triggers planner)');
  const r1 = await runQuery(
    'Compare AAPL and MSFT revenue growth and profit margins over the last 3 years',
    'Multi-company comparison with planner',
  );
  results.push(r1);
  printResult(r1, 1);

  // Test 2 — Simple: should NOT trigger planner
  header('Test 2 — Simple query (no planner)');
  const r2 = await runQuery(
    "In 2-3 sentences, what is the P/E ratio and why is it a useful metric?",
    'Simple definition query',
  );
  results.push(r2);
  printResult(r2, 2);

  // Test 3 — Complex single-company with data
  header('Test 3 — Complex single-company (triggers planner)');
  const r3 = await runQuery(
    "Analyze NVDA's financial health using revenue growth trends and key profitability metrics",
    'Single-company deep analysis',
  );
  results.push(r3);
  printResult(r3, 3);

  // Test 4 — Requires current data (forces tool usage via plan)
  header('Test 4 — Current data (plan guides tool calls)');
  const r4 = await runQuery(
    "Get the latest quarterly revenue and net income for AAPL, and their current market cap. Then compare to MSFT.",
    'Current data comparison (forces tools)',
  );
  results.push(r4);
  printResult(r4, 4);

  // Summary
  header('Results');
  const passed = results.filter(r => r.pass).length;
  const totalTime = results.reduce((s, r) => s + r.durationMs, 0);

  console.log(`\n  Passed : ${passed}/${results.length}`);
  console.log(`  Time   : ${(totalTime / 1000).toFixed(1)}s total`);
  console.log();
  console.log('  Planner verification:');
  for (const r of results) {
    const planIcon = r.planStarted ? '✓' : '—';
    const valIcon = r.selfValidated ? '✓' : '—';
    console.log(`    ${planIcon} plan  ${valIcon} validate  — ${r.label}`);
  }

  const failed = results.filter(r => !r.pass);
  if (failed.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failed) {
      console.log(`  - ${f.label}: ${f.error ?? 'no answer'}`);
    }
  }

  console.log(`\nPhase 5 verification complete.\n`);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
