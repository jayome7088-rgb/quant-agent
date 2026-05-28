import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createModel } from '../model/factory.js';
import { getTools } from '../tools/registry.js';
import { RawPlanSchema, normalizePlan, type ResearchPlan, type PlanOptions } from './types.js';
import { validatePlan } from './validator.js';

// ---------------------------------------------------------------------------
// Planner prompt
// ---------------------------------------------------------------------------

function buildPlanPrompt(query: string, toolList: string): string {
  return `You are a financial research planner. Your job is to decompose a complex financial research query into a sequence of concrete, executable steps.

## Available Tools
${toolList}

## Decomposition Rules
1. Each step must use EXACTLY ONE tool from the available tools list.
2. Steps should be ordered so that data-fetching happens before analysis.
3. Use "dependsOn" to express data dependencies between steps (refer to step IDs).
4. Target 3-8 steps. More than 10 is too granular; fewer than 2 is too coarse.
5. Give each step a short, descriptive ID (e.g., "fetch_aapl", "calc_growth").
6. For analysis/comparison steps that don't need a tool, set tool to "none".
7. The final step should synthesize findings into a conclusion.

## Query
${query}

## Output Format
Return a JSON object with this exact structure:
{
  "summary": "<one-sentence summary of the plan>",
  "steps": [
    {
      "id": "step_id",
      "goal": "What this step accomplishes",
      "tool": "tool_name or 'none'",
      "toolArgs": { "key": "value" },
      "dependsOn": ["earlier_step_id"],
      "expectedOutput": "What data/result this step should produce"
    }
  ]
}

IMPORTANT: Return ONLY the JSON object, no markdown fences, no extra text.`;
}

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

/**
 * Decompose a financial research query into a structured ResearchPlan.
 *
 * Uses the fast model variant (deepseek-v4-flash by default) to minimize
 * cost and latency. Falls back to the full model if the fast model produces
 * unparseable output.
 */
export async function createPlan(
  query: string,
  modelSpec: string,
  options: PlanOptions = {},
): Promise<ResearchPlan> {
  const provider = createModel(options.model ?? modelSpec);

  // Build tool list
  const tools = getTools(modelSpec);
  const toolList = tools
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join('\n');

  const messages = [
    new SystemMessage(
      'You are a precise AI that outputs ONLY valid JSON. Never wrap the output in markdown fences.',
    ),
    new HumanMessage(buildPlanPrompt(query, toolList)),
  ];

  let lastError: Error | null = null;

  // Try up to 2 times (fast model, then fallback to main model)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await provider.chat(messages, {
        model: options.model ?? modelSpec,
        signal: options.signal,
      });

      const raw = extractJson(result.content);
      const parsed = RawPlanSchema.parse(raw);
      const normalized = normalizePlan(parsed, query);
      const plan = validatePlan(normalized);

      return plan;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // On first failure, retry with the default model (not fast)
      if (attempt === 0 && options.model) {
        options = { ...options, model: undefined };
      }
    }
  }

  throw new Error(
    `Failed to generate a valid plan after 2 attempts: ${lastError?.message}`,
  );
}

// ---------------------------------------------------------------------------
// JSON extraction — handles markdown fences and extra text
// ---------------------------------------------------------------------------

function extractJson(text: string): unknown {
  // Strip markdown fences if present
  let cleaned = text.trim();

  // Remove ```json / ``` fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Find the outermost { ... } or [ ... ]
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  let start = -1;
  let end = -1;
  let openChar = '';

  if (firstBrace !== -1 && (firstBrace < firstBracket || firstBracket === -1)) {
    start = firstBrace;
    openChar = '{';
    end = findMatchingClose(cleaned, start, '{', '}');
  } else if (firstBracket !== -1) {
    start = firstBracket;
    openChar = '[';
    end = findMatchingClose(cleaned, start, '[', ']');
  }

  if (start !== -1 && end !== -1) {
    cleaned = cleaned.slice(start, end + 1);
  }

  return JSON.parse(cleaned);
}

function findMatchingClose(
  text: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}
