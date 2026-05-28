import { z } from 'zod';

// ---------------------------------------------------------------------------
// Research step status
// ---------------------------------------------------------------------------

export const ResearchStepStatus = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
]);

export type ResearchStepStatus = z.infer<typeof ResearchStepStatus>;

// ---------------------------------------------------------------------------
// ResearchStep & ResearchPlan
// ---------------------------------------------------------------------------

export interface ResearchStep {
  id: string;
  goal: string;
  tool: string;
  toolArgs: Record<string, unknown>;
  dependsOn: string[];
  expectedOutput: string;
  status: ResearchStepStatus;
  result?: string;
}

export interface ResearchPlan {
  query: string;
  steps: ResearchStep[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Raw LLM output schema — what the planner extracts from the LLM
// ---------------------------------------------------------------------------

const rawStepSchema = z.object({
  id: z.string(),
  goal: z.string(),
  tool: z.string(),
  toolArgs: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()),
  expectedOutput: z.string(),
});

export const RawPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(rawStepSchema),
});

export type RawPlan = z.infer<typeof RawPlanSchema>;

// ---------------------------------------------------------------------------
// Plan generation options
// ---------------------------------------------------------------------------

export interface PlanOptions {
  model?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Normalize raw plan — fills in defaults for missing optional fields
// ---------------------------------------------------------------------------

export function normalizePlan(raw: RawPlan, query: string): ResearchPlan {
  return {
    query,
    summary: raw.summary,
    steps: raw.steps.map((s, i) => ({
      id: s.id || `step_${i + 1}`,
      goal: s.goal,
      tool: s.tool || 'none',
      toolArgs: s.toolArgs ?? {},
      dependsOn: s.dependsOn ?? [],
      expectedOutput: s.expectedOutput,
      status: 'pending' as const,
    })),
  };
}
