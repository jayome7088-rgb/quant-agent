#!/usr/bin/env bun
/**
 * Phase 2 — End-to-End Verification
 *
 * Verifies the full Agent loop with real LLM calls:
 *   1. Agent.create() initializes correctly
 *   2. LLM streaming works (mode transitions visible in console)
 *   3. Thinking output is captured (DeepSeek V4 reasoning)
 *   4. Tool calls execute and return results
 *   5. Agent exits with final answer + token usage
 *
 * Usage:
 *   bun run src/verify-e2e.ts
 *
 * Prereqs:
 *   DEEPSEEK_API_KEY in .env
 *   FINANCIAL_DATASETS_API_KEY in .env (optional, for tool-calling test)
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

let modeSpinner = 0;
const MODE_ICONS: Record<string, string> = {
  requesting: '…',
  responding: '▌',
  thinking: '○',
  'tool-input': '▷',
  'tool-use': '◆',
};

// ---------------------------------------------------------------------------
// Run a single test query
// ---------------------------------------------------------------------------

async function runQuery(query: string, label: string, toolsAvailable: boolean): Promise<void> {
  header(label);

  const agent = await Agent.create();

  console.log(`\n  Query: "${query}"`);
  if (!toolsAvailable) {
    console.log('  (no financial tools — conversational only)');
  }
  hr();

  let iteration = 0;
  let toolCallCount = 0;
  let streamChars = 0;
  let lastMode = '';

  for await (const event of agent.run(query)) {
    switch (event.type) {
      // -----------------------------------------------------------------
      // Streaming progress — shows typewriter mode transitions
      // -----------------------------------------------------------------
      case 'stream_progress': {
        streamChars += event.charDelta;
        if (event.mode !== lastMode) {
          const icon = MODE_ICONS[event.mode] ?? '?';
          process.stdout.write(` ${icon} `);
          lastMode = event.mode;
        }
        break;
      }

      // -----------------------------------------------------------------
      // Thinking output (emitted when planning tool calls)
      // -----------------------------------------------------------------
      case 'thinking': {
        const preview = event.message.length > 150
          ? event.message.slice(0, 150) + '...'
          : event.message;
        console.log(`\n  [thinking] ${preview}`);
        break;
      }

      // -----------------------------------------------------------------
      // Tool execution events
      // -----------------------------------------------------------------
      case 'tool_start': {
        toolCallCount++;
        const args = JSON.stringify(event.args).slice(0, 100);
        console.log(`\n  [tool #${toolCallCount}] ${event.tool}(${args}...)`);
        break;
      }

      case 'tool_end': {
        const resultLen = typeof event.result === 'string' ? event.result.length : 0;
        console.log(`  [tool #${toolCallCount}] → ${resultLen.toLocaleString()} chars returned`);
        break;
      }

      case 'tool_error': {
        console.log(`  [tool #${toolCallCount}] ERROR: ${event.error}`);
        break;
      }

      // -----------------------------------------------------------------
      // Context management
      // -----------------------------------------------------------------
      case 'compaction': {
        if (event.phase === 'start' && event.preCompactTokens) {
          console.log(`\n  [compacting — context at ${event.preCompactTokens.toLocaleString()} tokens]`);
        } else if (event.phase === 'end' && event.success) {
          console.log(`  [compacted → ${event.postCompactTokens?.toLocaleString() ?? '?'} tokens]`);
        }
        break;
      }

      case 'context_cleared': {
        console.log(`\n  [context overflow — cleared ${event.clearedCount} rounds]`);
        break;
      }

      case 'memory_flush': {
        console.log(`\n  [memory flush: ${event.phase}]`);
        break;
      }

      // -----------------------------------------------------------------
      // Final answer
      // -----------------------------------------------------------------
      case 'done': {
        iteration = event.iterations;
        console.log('\n');
        hr('═');
        console.log(`\n  Final answer (${iteration} iterations, ${(event.totalTime / 1000).toFixed(1)}s):\n`);
        console.log(event.answer);
        console.log();
        hr('═');

        if (event.tokenUsage) {
          const { inputTokens, outputTokens } = event.tokenUsage;
          const tps = event.tokensPerSecond?.toFixed(0) ?? '—';
          console.log(
            `  Tokens: ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out ` +
            `(${tps} t/s) | Tool calls: ${toolCallCount}`,
          );
        }
        console.log();
        break;
      }

      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.clear();
  console.log('QuantAgent — Phase 2 E2E Verification\n');
  console.log(`  Provider : ${process.env.LLM_PROVIDER ?? 'deepseek'}`);
  console.log(`  Model    : deepseek-v4-pro`);

  // Validate API key
  if (!process.env.DEEPSEEK_API_KEY?.startsWith('sk-')) {
    console.log('\n  ERROR: DEEPSEEK_API_KEY is not set or invalid.');
    console.log('  Open .env and set DEEPSEEK_API_KEY to your actual key.\n');
    process.exit(1);
  }
  console.log('  API key  : ✓');
  console.log();

  const hasFinancial = !!process.env.FINANCIAL_DATASETS_API_KEY;

  // Test 1 — conversational (always works)
  await runQuery(
    'In exactly 3 bullet points, what are the most important financial metrics for evaluating a technology company?',
    'Test 1 — Conversational (no tools)',
    hasFinancial,
  );

  // Test 2 — financial data (only if API key is set)
  if (hasFinancial) {
    await runQuery(
      'Get the latest annual revenue and net income for AAPL.',
      'Test 2 — Financial Data Tools',
      true,
    );
  } else {
    console.log('  Skipping Test 2 — set FINANCIAL_DATASETS_API_KEY in .env to test tool calling.\n');
  }

  console.log('Phase 2 complete.\n');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
