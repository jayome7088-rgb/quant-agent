import { type ResearchPlan, type ResearchStep } from './types.js';

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

export interface ValidationError {
  type: 'cycle' | 'missing_dependency' | 'duplicate_id' | 'invalid_tool' | 'empty_plan';
  message: string;
  stepIds?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
  plan: ResearchPlan | null;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a ResearchPlan. Checks for:
 *   - Dependency cycles
 *   - References to nonexistent steps
 *   - Duplicate step IDs
 *   - Empty plan
 *   - Missing tool specifications
 */
export function validatePlan(plan: ResearchPlan): ResearchPlan {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  // Empty plan check
  if (plan.steps.length === 0) {
    errors.push({ type: 'empty_plan', message: 'Plan has no steps' });
    throw new PlanValidationError(errors, warnings);
  }

  // Duplicate step IDs
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      errors.push({
        type: 'duplicate_id',
        message: `Duplicate step ID: "${step.id}"`,
        stepIds: [step.id],
      });
    }
    ids.add(step.id);
  }

  if (errors.length > 0) {
    throw new PlanValidationError(errors, warnings);
  }

  // Missing dependencies
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        errors.push({
          type: 'missing_dependency',
          message: `Step "${step.id}" depends on "${dep}" which does not exist`,
          stepIds: [step.id, dep],
        });
      }
    }
  }

  if (errors.length > 0) {
    throw new PlanValidationError(errors, warnings);
  }

  // Cycle detection
  const cyclePath = detectCycle(plan.steps);
  if (cyclePath) {
    errors.push({
      type: 'cycle',
      message: `Dependency cycle detected: ${cyclePath.join(' → ')}`,
      stepIds: cyclePath,
    });
    throw new PlanValidationError(errors, warnings);
  }

  // Warnings
  for (const step of plan.steps) {
    if (step.tool === 'none' && step.dependsOn.length === 0) {
      warnings.push(
        `Step "${step.id}" has no tool and no dependencies — it may not have data to work with`,
      );
    }
  }

  if (plan.steps.length > 10) {
    warnings.push(`Plan has ${plan.steps.length} steps — consider reducing complexity`);
  }
  if (plan.steps.length === 1) {
    warnings.push('Plan has only 1 step — consider whether decomposition is needed');
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Cycle detection via DFS
// ---------------------------------------------------------------------------

interface StepNode {
  id: string;
  dependsOn: string[];
}

function detectCycle(steps: StepNode[]): string[] | null {
  const index = new Map<string, number>();
  steps.forEach((s, i) => index.set(s.id, i));

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Array(steps.length).fill(WHITE);
  const parent = new Array<number | null>(steps.length).fill(null);

  function dfs(nodeIdx: number): string[] | null {
    color[nodeIdx] = GRAY;
    const step = steps[nodeIdx];

    for (const dep of (step.dependsOn ?? [])) {
      const depIdx = index.get(dep);
      if (depIdx === undefined) continue; // Already caught by missing_dependency check

      if (color[depIdx] === GRAY) {
        // Found a cycle — reconstruct the path
        const cycle: string[] = [dep];
        let current = nodeIdx;
        while (current !== depIdx) {
          cycle.push(steps[current].id);
          current = parent[current]!;
        }
        cycle.push(dep);
        cycle.reverse();
        return cycle;
      }

      if (color[depIdx] === WHITE) {
        parent[depIdx] = nodeIdx;
        const result = dfs(depIdx);
        if (result) return result;
      }
    }

    color[nodeIdx] = BLACK;
    return null;
  }

  for (let i = 0; i < steps.length; i++) {
    if (color[i] === WHITE) {
      const cycle = dfs(i);
      if (cycle) return cycle;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plan validation error class
// ---------------------------------------------------------------------------

export class PlanValidationError extends Error {
  public readonly errors: ValidationError[];
  public readonly warnings: string[];

  constructor(errors: ValidationError[], warnings: string[]) {
    const msg = errors.map((e) => e.message).join('; ');
    super(msg);
    this.name = 'PlanValidationError';
    this.errors = errors;
    this.warnings = warnings;
  }
}
