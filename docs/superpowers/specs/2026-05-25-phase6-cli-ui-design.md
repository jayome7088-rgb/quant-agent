# Phase 6 — CLI UI Design Spec

> Date: 2026-05-25
> Status: approved

## Overview

Build a full-screen multi-panel terminal UI for Dexter Pro using Ink v5 + React 19. The agent's async generator event stream drives the React component tree via `useReducer`.

## Architecture

**Pattern:** Single `<App>` component with `useReducer` managing all state. Agent runs in `useEffect`, each event dispatches to the reducer, triggering re-render.

**File structure:**

```
src/
├── index.tsx                    # Entry: load env, render <App>
├── ui/
│   ├── app.tsx                  # <App> — useReducer + useEffect driving agent
│   ├── components/
│   │   ├── header.tsx           # Logo + provider/model + mode icon
│   │   ├── plan-panel.tsx       # Conditional: step list + progress
│   │   ├── tools-panel.tsx      # Tool call log (scrollable, last 5 shown)
│   │   ├── output-box.tsx       # Main output: streaming text + rendered markdown
│   │   ├── footer.tsx           # tokens | iter | time | plan progress
│   │   ├── input-bar.tsx        # "$ " prompt + TextInput with history
│   │   └── mode-indicator.tsx   # requesting/thinking/responding/tool-use icon
│   ├── reducer.ts               # AgentEvent → UIState transformation
│   └── table-renderer.ts        # Box-draw markdown table converter
```

All UI code under `src/ui/`. `src/index.tsx` only loads env and renders `<App>`.

## State Design

```typescript
interface UIState {
  query: string;
  running: boolean;
  mode: 'idle' | 'requesting' | 'thinking' | 'responding' | 'tool-use';
  plan: {
    visible: boolean;
    summary: string;
    steps: Array<{ id: string; goal: string; status: string; tool?: string }>;
    complete: boolean;
  } | null;
  tools: Array<{
    id: string; name: string; args: string;
    status: 'running' | 'done' | 'error';
    result?: string; duration?: number;
  }>;
  output: string;
  thinkingText: string;
  tokens: { in: number; out: number };
  iteration: number;
  elapsed: number;
  done: boolean;
  answer: string;
}
```

**Reducer event mapping:** Each `AgentEvent` type maps to a specific state transition:
- `stream_progress` → update `mode`
- `thinking` → append to `thinkingText`
- `plan_start` → create `plan`, set `visible=true`
- `plan_step` → update matching step status
- `plan_complete` → set `plan.complete=true`
- `tool_start` → append running entry to `tools[]`
- `tool_end` → mark done, fill result + duration
- `tool_error` → mark error
- `done` → set `running=false`, `done=true`, fill answer/tokens/iter

When `mode` transitions from `thinking` to `responding`, `thinkingText` is merged into `output` as a gray prefix before responding text appends.

## Data Flow

```typescript
function App({ query }: { query: string }) {
  const [state, dispatch] = useReducer(reducer, initialState(query));

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const agent = await Agent.create({ usePlanner: true });
      if (cancelled) return;
      for await (const event of agent.run(query)) {
        if (cancelled) break;
        dispatch(event);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [query]);

  return (
    <Box flexDirection="column">
      <Header mode={state.mode} />
      {state.plan?.visible && <PlanPanel plan={state.plan} />}
      <ToolsPanel tools={state.tools} />
      <OutputBox output={state.output} thinking={state.thinkingText} />
      <Footer ... />
      <InputBar ... />
    </Box>
  );
}
```

- New query from InputBar updates `query` state → `useEffect` re-runs → `initialState()` resets
- `Ctrl+C` uses Ink's default exit behavior
- Cleanup via `cancelled` flag prevents stale dispatches

## Component Specifications

### Header (fixed top, 2 rows)

```
 Dexter Pro — autonomous financial research agent    deepseek-v4-pro  ⠋ requesting
 ═══════════════════════════════════════════════════════════════════════════════
```

- Left: logo text (bold, cyan)
- Center: tagline
- Right: model name + mode indicator
- Bottom: `═` separator, full width

### Mode Indicator

| Mode | Icon | Color |
|------|------|-------|
| requesting | `⠋` (spinner) | yellow |
| thinking | `○` | gray |
| responding | `⠂` | green |
| tool-use | `◇` | blue |

Uses `ink-spinner` for `requesting` phase.

### Plan Panel (conditional, auto-collapses when complete)

```
┌─ Plan: Compare AAPL vs MSFT revenue growth ──────────────────────┐
│  ✓ fetch_aapl    Get AAPL revenue                         [use: get_financials]  │
│  ✓ fetch_msft    Get MSFT revenue                         [use: get_financials]  │
│  ▶ calc_growth   Calculate YoY growth (dep: 1,2)          [use: none]           │
│  ○ synthesize    Write conclusion                         [use: none]           │
│  [3/4] Calculate YoY growth (dep: 1,2)                                         │
└──────────────────────────────────────────────────────────┘
```

- Only rendered when `plan.visible === true` (i.e., planner was triggered)
- Step status icons: ✓ done (green), ▶ running (cyan), ○ pending (gray), ✗ failed (red)
- Bottom line: `[current/total] goal`
- Panel auto-collapses (hidden) when `plan.complete === true`

### Tools Panel (scrollable, shows last 5 by default)

```
┌─ Tools ─────────────────────────────────────────────────┐
│  ◆ get_financials("AAPL annual revenue...")              │
│     → 3 rows returned (821ms)                            │
│  ◆ get_market_data("NVDA stock price")                   │
│     → $214.30 (312ms)                                    │
│  ◇ get_financials("MSFT annual revenue...")              │
│     → 3 rows returned (748ms)                            │
└──────────────────────────────────────────────────────────┘
```

- Running: ◆ (spinner via `ink-spinner`, cyan)
- Done: ◇ (green) + result summary
- Error: ✗ (red) + error message
- Default visible: last 5 entries
- `Ctrl+T` toggles expand/collapse (future)

### Output Box (flex-grow main area)

- Renders `state.output` as markdown
- Thinking text rendered in gray (#888) italic
- Box-draw table rendering: detects `| col | col |` lines, converts to Unicode box-draw characters
- Streaming: Ink's natural re-render provides typewriter effect; no extra animation needed

### Footer (fixed bottom, 1 row)

```
 12.4K in / 3.2K out  |  iter 3/10  |  45.2s  |  plan: 3/4 steps
```

- Gray text, single row
- Four segments separated by `|`
- Plan segment only shown when plan is active

### Input Bar (fixed bottom)

```
$ _
```

- `$ ` prompt (cyan)
- Uses `ink-text-input` for input
- Arrow key history (up/down for previous queries)
- Submit on Enter; input bar remains visible during agent execution (submitting while running is a no-op)

## Keyboard Shortcuts

Minimal set:
- `Enter` — submit query
- `Ctrl+C` — exit (Ink default)
- `Ctrl+T` — expand/collapse Tools panel (future)

## Table Renderer

`table-renderer.ts` detects markdown table patterns and converts to box-draw:

Input:
```
| Period | Revenue | Op Inc | Net Inc | EPS   |
|--------|---------|--------|---------|-------|
| FY 25  | 394.3B  | 128.6B | 100.4B  | $7.15 |
```

Output:
```
┌────────┬─────────┬────────┬─────────┬───────┐
│ Period │ Revenue │ Op Inc │ Net Inc │ EPS   │
├────────┼─────────┼────────┼─────────┼───────┤
│ FY 25  │ 394.3B  │ 128.6B │ 100.4B  │ $7.15 │
└────────┴─────────┴────────┴─────────┴───────┘
```

Algorithm: measure max column widths from all rows, then draw with Unicode box-draw characters.

## Dependencies

All already in `package.json`:
- `ink` v5 — terminal UI framework
- `ink-spinner` v5 — spinner component
- `ink-text-input` v6 — text input component
- `react` v19 — component model

No new packages required.

## Out of Scope

- Color themes / customization — use fixed color scheme
- Custom keybindings / `keybindings.json` — not needed for MVP
- Report export (Phase 7)
- Local memory integration (Phase 7)
- Multi-line input or code blocks in input
