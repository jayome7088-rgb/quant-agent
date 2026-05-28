import type { AgentEvent } from '../agent/types.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type UIMode = 'idle' | 'requesting' | 'thinking' | 'responding' | 'tool-use';

export interface PlanState {
  visible: boolean;
  summary: string;
  steps: Array<{ id: string; goal: string; status: string; tool?: string }>;
  complete: boolean;
}

export interface ToolEntry {
  id: string;
  name: string;
  args: string;
  status: 'running' | 'done' | 'error';
  result?: string;
  duration?: number;
}

export interface UIState {
  query: string;
  running: boolean;
  mode: UIMode;
  plan: PlanState | null;
  tools: ToolEntry[];
  output: string;
  thinkingText: string;
  tokens: { in: number; out: number };
  iteration: number;
  elapsed: number;
  done: boolean;
  answer: string;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function initialState(query: string): UIState {
  return {
    query,
    running: true,
    mode: 'requesting',
    plan: null,
    tools: [],
    output: '',
    thinkingText: '',
    tokens: { in: 0, out: 0 },
    iteration: 0,
    elapsed: 0,
    done: false,
    answer: '',
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reducer(state: UIState, event: AgentEvent): UIState {
  switch (event.type) {
    case 'stream_progress': {
      // StreamMode has 'tool-input' but UIMode doesn't — map it to 'tool-use'
      const mode: UIMode =
        event.mode === 'tool-input' ? 'tool-use' : event.mode;
      const next: UIState = { ...state, mode };

      // On mode transition from thinking → responding, merge thinking text into output
      if (event.mode === 'responding' && state.thinkingText) {
        next.output = state.output + `\n\x1b[90m${state.thinkingText}\x1b[0m\n`;
        next.thinkingText = '';
      }
      return next;
    }

    case 'thinking': {
      return { ...state, thinkingText: state.thinkingText + event.message };
    }

    case 'plan_start': {
      return {
        ...state,
        plan: {
          visible: true,
          summary: event.summary,
          steps: [],
          complete: false,
        },
      };
    }

    case 'plan_step': {
      if (!state.plan) return state;
      const steps = state.plan.steps.map(s =>
        s.id === event.stepId ? { ...s, status: event.status } : s,
      );
      // If step is new, add it
      const exists = steps.some(s => s.id === event.stepId);
      if (!exists) {
        steps.push({
          id: event.stepId,
          goal: event.goal,
          status: event.status,
        });
      }
      return { ...state, plan: { ...state.plan, steps } };
    }

    case 'plan_complete': {
      if (!state.plan) return state;
      return { ...state, plan: { ...state.plan, complete: true, visible: false } };
    }

    case 'tool_start': {
      const argsStr = event.args
        ? Object.entries(event.args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ')
        : '';
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            id: event.toolCallId ?? event.tool,
            name: event.tool,
            args: argsStr,
            status: 'running' as const,
          },
        ],
      };
    }

    case 'tool_end': {
      return {
        ...state,
        tools: state.tools.map(t =>
          t.id === (event.toolCallId ?? event.tool)
            ? { ...t, status: 'done' as const, result: event.result.slice(0, 200), duration: event.duration }
            : t,
        ),
      };
    }

    case 'tool_error': {
      return {
        ...state,
        tools: state.tools.map(t =>
          t.id === (event.toolCallId ?? event.tool)
            ? { ...t, status: 'error' as const, result: event.error }
            : t,
        ),
      };
    }

    case 'done': {
      return {
        ...state,
        running: false,
        done: true,
        answer: event.answer,
        iteration: event.iterations,
        elapsed: event.totalTime,
        tokens: event.tokenUsage
          ? { in: event.tokenUsage.inputTokens, out: event.tokenUsage.outputTokens }
          : state.tokens,
        output: state.output + '\n\n' + event.answer,
        mode: 'idle' as const,
      };
    }

    // Events that don't mutate UI state:
    case 'tool_progress':
    case 'tool_approval':
    case 'tool_denied':
    case 'tool_limit':
    case 'context_cleared':
    case 'compaction':
    case 'microcompact':
    case 'memory_flush':
    case 'memory_recalled':
    case 'queue_drain':
    case 'self_validation':
      return state;

    default:
      return state;
  }
}
