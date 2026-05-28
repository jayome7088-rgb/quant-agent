import type { ResearchPlan, ResearchStep } from '../planner/types.js';
import { createPlan } from '../planner/planner.js';

// ---------------------------------------------------------------------------
// PlanExecutor — tracks execution of a ResearchPlan within the agent loop
// ---------------------------------------------------------------------------

export class PlanExecutor {
  readonly plan: ResearchPlan;
  private stepIndex: number = 0;
  private startedAt: number = Date.now();

  constructor(plan: ResearchPlan) {
    this.plan = plan;
    this.plan.steps[0]!.status = 'running';
  }

  /** Create a PlanExecutor by decomposing the query via the planner LLM. */
  static async fromQuery(query: string, model: string): Promise<PlanExecutor> {
    const plan = await createPlan(query, model);
    return new PlanExecutor(plan);
  }

  /** The step currently being executed. */
  get currentStep(): ResearchStep | null {
    if (this.stepIndex >= this.plan.steps.length) return null;
    return this.plan.steps[this.stepIndex]!;
  }

  /** Whether all steps are complete. */
  get isComplete(): boolean {
    return this.stepIndex >= this.plan.steps.length;
  }

  /** Human-readable progress string for display. */
  get progress(): string {
    if (this.isComplete) return `Plan complete (${this.plan.steps.length} steps)`;
    const s = this.currentStep!;
    return `[${this.stepIndex + 1}/${this.plan.steps.length}] ${s.goal}`;
  }

  /** Mark the current step as done and advance to the next one. */
  advance(result?: string): void {
    const step = this.plan.steps[this.stepIndex];
    if (step) {
      step.status = 'done';
      if (result) step.result = result;
    }
    this.stepIndex++;
    const next = this.plan.steps[this.stepIndex];
    if (next) next.status = 'running';
  }

  /** Mark the current step as failed and advance. */
  skip(reason: string): void {
    const step = this.plan.steps[this.stepIndex];
    if (step) {
      step.status = 'skipped';
      step.result = reason;
    }
    this.stepIndex++;
    const next = this.plan.steps[this.stepIndex];
    if (next) next.status = 'running';
  }

  /** Format the plan for injection into the system prompt. */
  formatForPrompt(): string {
    const lines = [
      '## Research Plan',
      '',
      `Goal: ${this.plan.summary}`,
      '',
      'Follow these steps in order. Use the specified tool for each data-fetching step.',
      'After each step, check whether the data satisfies the goal before moving on.',
      '',
      '### Steps',
    ];
    for (const step of this.plan.steps) {
      const icon = step.status === 'done' ? '✓'
        : step.status === 'running' ? '▶'
        : step.status === 'failed' ? '✗'
        : step.status === 'skipped' ? '−'
        : '○';
      const extra = step.result ? ` — ${step.result.slice(0, 120)}` : '';
      const toolHint = step.tool !== 'none' ? ` [use: ${step.tool}]` : '';
      lines.push(`${icon} **${step.id}**: ${step.goal}${toolHint}${extra}`);
    }
    lines.push('', 'Current: ' + this.progress);
    return lines.join('\n');
  }

  /** Elapsed time since plan started. */
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}

// ---------------------------------------------------------------------------
// Heuristics — should we plan this query?
// ---------------------------------------------------------------------------

/** Keywords that suggest a query benefits from decomposition. */
const PLAN_TRIGGERS = [
  'compare', 'versus', 'vs ', 'vs. ',
  'and also', 'as well as',
  'screener', 'screen for', 'find stocks',
  'analyze', 'evaluate', 'break down',
  'pros and cons', 'which is better',
  'portfolio', 'diversify',
  'over the last', 'over the past', 'trend',
  'multiple', 'across', 'between',
];

/**
 * Heuristic: returns true when the query likely benefits from
 * planner decomposition. False for simple lookups.
 */
export function shouldUsePlanner(query: string): boolean {
  const lower = query.toLowerCase();
  const wordCount = lower.split(/\s+/).length;
  // Very short queries don't need planning
  if (wordCount < 4) return false;
  // Check for trigger keywords
  return PLAN_TRIGGERS.some(t => lower.includes(t));
}
