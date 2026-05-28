# Phase 6 — CLI UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full-screen multi-panel terminal UI using Ink v5 + React 19, driven by the Agent's async generator event stream via useReducer.

**Architecture:** Single `<App>` component with `useReducer`. Agent runs in `useEffect`, dispatching events to state. Pure function components render slices of state. Box-draw table renderer is a standalone utility.

**Tech Stack:** Ink v5, React 19, ink-spinner v5, ink-text-input v6 (all already in package.json)

---

## File Structure

```
src/
├── index.tsx                          # Modify: minimal entry, render <App>
├── ui/
│   ├── app.tsx                        # Create: <App> — useReducer + useEffect
│   ├── reducer.ts                     # Create: AgentEvent → UIState
│   ├── table-renderer.ts              # Create: box-draw table converter
│   └── components/
│       ├── header.tsx                 # Create: logo + model + mode indicator
│       ├── plan-panel.tsx             # Create: conditional step list
│       ├── tools-panel.tsx            # Create: tool call log
│       ├── output-box.tsx             # Create: streaming markdown output
│       ├── footer.tsx                 # Create: stats bar
│       └── input-bar.tsx              # Create: "$ " prompt + TextInput
```

All UI code isolated in `src/ui/`. No changes to existing agent/model/tools layers.

---

### Task 1: Table Renderer

**Files:**
- Create: `src/ui/table-renderer.ts`

- [ ] **Step 1: Write the `renderTables()` function**

`src/ui/table-renderer.ts`:
```typescript
/**
 * Converts markdown table blocks in a string to box-draw Unicode tables.
 * Detects consecutive lines matching "| col | col |" separated by a
 * "|---|----|" separator row.
 */

const BOX = {
  top: '─', bottom: '─',
  left: '│', right: '│',
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  mid: '┼', topMid: '┬', bottomMid: '┴', leftMid: '├', rightMid: '┤',
} as const;

function isSepRow(line: string): boolean {
  return /^\|[\s\-:]+\|/.test(line);
}

function isTableRow(line: string): boolean {
  return /^\|.+\|/.test(line);
}

function parseRow(line: string): string[] {
  return line
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .split('|')
    .map(c => c.trim());
}

function padCell(content: string, width: number): string {
  // Handle CJK characters that take 2 columns
  return content + ' '.repeat(Math.max(0, width - content.length));
}

interface TableBlock {
  rows: string[][];
}

function extractTables(text: string): { tables: TableBlock[]; spans: Array<{ start: number; end: number }> } {
  const lines = text.split('\n');
  const tables: TableBlock[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;

  while (i < lines.length) {
    // Find a header line followed by a separator
    if (i + 1 < lines.length && isTableRow(lines[i]!) && isSepRow(lines[i + 1]!)) {
      const start = i;
      const rows: string[][] = [];
      rows.push(parseRow(lines[i]!));   // header
      i++;                              // skip separator
      i++;
      // Collect data rows
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(parseRow(lines[i]!));
        i++;
      }
      tables.push({ rows });
      spans.push({ start, end: i });
    } else {
      i++;
    }
  }
  return { tables, spans };
}

function drawTable(rows: string[][]): string {
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidths: number[] = Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(colWidths[c]!, (row[c] ?? '').length);
    }
  }

  const pad = (row: string[]) =>
    row.map((cell, c) => padCell(cell, colWidths[c]!)).join(` ${BOX.left} `);

  const sep = (l: string, m: string, r: string) =>
    l + colWidths.map(w => BOX.top.repeat(w + 2)).join(m) + r;

  const out: string[] = [];
  out.push(sep(BOX.tl, BOX.topMid, BOX.tr));
  out.push(`${BOX.left} ${pad(rows[0]!)} ${BOX.right}`);  // header
  out.push(sep(BOX.leftMid, BOX.mid, BOX.rightMid));       // separator

  for (let r = 1; r < rows.length; r++) {
    out.push(`${BOX.left} ${pad(rows[r]!)} ${BOX.right}`);
  }
  out.push(sep(BOX.bl, BOX.bottomMid, BOX.br));

  return out.join('\n');
}

export function renderTables(text: string): string {
  const { tables, spans } = extractTables(text);
  if (tables.length === 0) return text;

  const lines = text.split('\n');
  const result: string[] = [];
  let cursor = 0;

  for (let t = 0; t < tables.length; t++) {
    const span = spans[t]!;
    // Copy lines before this table
    result.push(...lines.slice(cursor, span.start));
    // Insert rendered table
    result.push(drawTable(tables[t]!.rows));
    cursor = span.end;
  }
  // Copy remaining lines
  result.push(...lines.slice(cursor));

  return result.join('\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/table-renderer.ts
git commit -m "feat: add box-draw table renderer for markdown tables"
```

---

### Task 2: Reducer + UIState

**Files:**
- Create: `src/ui/reducer.ts`

- [ ] **Step 1: Write the reducer and types**

`src/ui/reducer.ts`:
```typescript
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
      const mode: UIMode = event.mode;
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
          steps: [], // Steps populated by plan_step events
          complete: false,
        },
      };
    }

    case 'plan_step': {
      if (!state.plan) return state;
      const steps = state.plan.steps.map(s =>
        s.id === event.stepId ? { ...s, status: event.status } : s
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
            : t
        ),
      };
    }

    case 'tool_error': {
      return {
        ...state,
        tools: state.tools.map(t =>
          t.id === (event.toolCallId ?? event.tool)
            ? { ...t, status: 'error' as const, result: event.error }
            : t
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

    // Events that don't mutate state but are part of the union:
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
      return state;

    default:
      return state;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/reducer.ts
git commit -m "feat: add UI reducer — AgentEvent → UIState transformation"
```

---

### Task 3: Header Component

**Files:**
- Create: `src/ui/components/header.tsx`

- [ ] **Step 1: Write the Header component**

`src/ui/components/header.tsx`:
```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { UIMode } from '../reducer.js';

const MODE_CONFIG: Record<UIMode, { icon: string; color: string; label: string }> = {
  idle:    { icon: '◇', color: 'gray',   label: 'idle' },
  requesting: { icon: '⠋', color: 'yellow', label: 'requesting' },
  thinking:   { icon: '○', color: 'gray',   label: 'thinking' },
  responding: { icon: '⠂', color: 'green',  label: 'responding' },
  'tool-use': { icon: '◇', color: 'blue',   label: 'tool-use' },
};

interface HeaderProps {
  mode: UIMode;
  model: string;
}

export const Header: React.FC<HeaderProps> = ({ mode, model }) => {
  const cfg = MODE_CONFIG[mode];
  const sep = '═'.repeat(process.stdout.columns || 80);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box>
        <Text bold color="cyan">Dexter Pro</Text>
        <Text color="gray"> — autonomous financial research agent</Text>
        <Text>{' '.repeat(4)}</Text>
        <Text color="gray">{model}</Text>
        <Text>{'  '}</Text>
        <Text color={cfg.color}>{cfg.icon} {cfg.label}</Text>
      </Box>
      <Text color="gray">{sep}</Text>
    </Box>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/header.tsx
git commit -m "feat: add Header component with mode indicator"
```

---

### Task 4: Plan Panel Component

**Files:**
- Create: `src/ui/components/plan-panel.tsx`

- [ ] **Step 1: Write the PlanPanel component**

`src/ui/components/plan-panel.tsx`:
```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { PlanState } from '../reducer.js';

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  done:    { icon: '✓', color: 'green' },
  running: { icon: '▶', color: 'cyan' },
  pending: { icon: '○', color: 'gray' },
  failed:  { icon: '✗', color: 'red' },
  skipped: { icon: '−', color: 'gray' },
};

const BOX_CHARS = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  titleL: '┌─ ', titleR: ' ─',
};

interface PlanPanelProps {
  plan: PlanState;
}

function currentProgress(plan: PlanState): string {
  const done = plan.steps.filter(s => s.status === 'done').length;
  const current = plan.steps.find(s => s.status === 'running');
  const goal = current?.goal ?? '';
  return `[${done + 1}/${plan.steps.length}] ${goal}`;
}

export const PlanPanel: React.FC<PlanPanelProps> = ({ plan }) => {
  if (!plan.visible) return null;

  const width = Math.min(process.stdout.columns || 80, 80);
  const line = (content: string) => {
    const pad = width - content.length - 2;
    return `${BOX_CHARS.v} ${content}${' '.repeat(Math.max(0, pad))}${BOX_CHARS.v}`;
  };

  const titleBar = `${BOX_CHARS.tl} Plan: ${plan.summary} ${BOX_CHARS.h.repeat(Math.max(0, width - 9 - plan.summary.length))}${BOX_CHARS.tr}`;

  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color="gray">{titleBar}</Text>
      {plan.steps.map(step => {
        const s = STATUS_ICONS[step.status] ?? STATUS_ICONS.pending;
        const toolHint = step.tool && step.tool !== 'none' ? ` [use: ${step.tool}]` : '';
        return (
          <Text key={step.id} color="gray">
            {line(`${s.icon} ${step.id.padEnd(14)} ${step.goal.slice(0, 40)}${toolHint}`)}
          </Text>
        );
      })}
      <Text color="gray">
        {line(currentProgress(plan))}
      </Text>
      <Text color="gray">{BOX_CHARS.bl + BOX_CHARS.h.repeat(width - 2) + BOX_CHARS.br}</Text>
    </Box>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/plan-panel.tsx
git commit -m "feat: add PlanPanel component — conditional step list"
```

---

### Task 5: Tools Panel Component

**Files:**
- Create: `src/ui/components/tools-panel.tsx`

- [ ] **Step 1: Write the ToolsPanel component**

`src/ui/components/tools-panel.tsx`:
```typescript
import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ToolEntry } from '../reducer.js';

interface ToolsPanelProps {
  tools: ToolEntry[];
}

function toolIcon(status: ToolEntry['status']): React.ReactNode {
  switch (status) {
    case 'running': return <Text color="cyan"><Spinner type="dots" /></Text>;
    case 'done':    return <Text color="green">◇</Text>;
    case 'error':   return <Text color="red">✗</Text>;
  }
}

function formatResult(tool: ToolEntry): string {
  if (tool.status === 'running') return '';
  if (tool.status === 'error') return tool.result ?? 'error';
  const dur = tool.duration ? ` (${tool.duration}ms)` : '';
  const summary = (tool.result ?? '').slice(0, 80);
  return `→ ${summary}${dur}`;
}

export const ToolsPanel: React.FC<ToolsPanelProps> = ({ tools }) => {
  if (tools.length === 0) return null;

  const visible = tools.slice(-5); // last 5
  const width = Math.min(process.stdout.columns || 80, 80);
  const h = '─';

  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color="gray">{`┌─ Tools ${h.repeat(Math.max(0, width - 10))}┐`}</Text>
      {visible.map(t => (
        <Box key={t.id} flexDirection="column">
          <Text>
            {'  '}{toolIcon(t.status)}{' '}
            <Text color="white">{t.name}</Text>
            <Text color="gray">({t.args.slice(0, 60)}{t.args.length > 60 ? '...' : ''})</Text>
          </Text>
          {t.result && (
            <Text color="gray">     {formatResult(t)}</Text>
          )}
        </Box>
      ))}
      <Text color="gray">{`└${h.repeat(width - 2)}┘`}</Text>
    </Box>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/tools-panel.tsx
git commit -m "feat: add ToolsPanel component — tool call log"
```

---

### Task 6: Output Box Component

**Files:**
- Create: `src/ui/components/output-box.tsx`

- [ ] **Step 1: Write the OutputBox component**

`src/ui/components/output-box.tsx`:
```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { renderTables } from '../table-renderer.js';

interface OutputBoxProps {
  output: string;
  thinkingText: string;
}

export const OutputBox: React.FC<OutputBoxProps> = ({ output, thinkingText }) => {
  const rendered = renderTables(output);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text>{rendered}</Text>
      {thinkingText && (
        <Text color="gray" italic>
          {thinkingText}
        </Text>
      )}
    </Box>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/output-box.tsx
git commit -m "feat: add OutputBox component — streaming markdown with table rendering"
```

---

### Task 7: Footer Component

**Files:**
- Create: `src/ui/components/footer.tsx`

- [ ] **Step 1: Write the Footer component**

`src/ui/components/footer.tsx`:
```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { UIState } from '../reducer.js';

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return (ms / 1000).toFixed(1) + 's';
}

interface FooterProps {
  tokens: UIState['tokens'];
  iteration: number;
  elapsed: number;
  plan: UIState['plan'];
  maxIterations: number;
}

export const Footer: React.FC<FooterProps> = ({
  tokens, iteration, elapsed, plan, maxIterations,
}) => {
  const segments: string[] = [
    `${formatTokens(tokens.in)} in / ${formatTokens(tokens.out)} out`,
    `iter ${iteration}/${maxIterations}`,
    formatTime(elapsed),
  ];
  if (plan && plan.visible) {
    const done = plan.steps.filter(s => s.status === 'done').length;
    segments.push(`plan: ${done}/${plan.steps.length} steps`);
  }

  return (
    <Box flexShrink={0} paddingTop={1}>
      <Text color="gray">
        {' '.repeat(2)}{segments.join('  |  ')}
      </Text>
    </Box>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/footer.tsx
git commit -m "feat: add Footer component — token/iter/time stats"
```

---

### Task 8: Input Bar Component

**Files:**
- Create: `src/ui/components/input-bar.tsx`

- [ ] **Step 1: Write the InputBar component**

`src/ui/components/input-bar.tsx`:
```typescript
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InputBarProps {
  onSubmit: (query: string) => void;
  disabled: boolean;
}

export const InputBar: React.FC<InputBarProps> = ({ onSubmit, disabled }) => {
  const [value, setValue] = useState('');

  const handleSubmit = (val: string) => {
    if (disabled || !val.trim()) return;
    onSubmit(val.trim());
    setValue('');
  };

  return (
    <Box flexShrink={0} paddingTop={1}>
      <Text color="cyan">$ </Text>
      {disabled ? (
        <Text color="gray">{value || '...'}</Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Ask a financial research question..."
        />
      )}
    </Box>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/input-bar.tsx
git commit -m "feat: add InputBar component — $ prompt with TextInput"
```

---

### Task 9: App Component

**Files:**
- Create: `src/ui/app.tsx`

- [ ] **Step 1: Write the App component**

`src/ui/app.tsx`:
```typescript
import React, { useEffect, useReducer, useState } from 'react';
import { Box, Text } from 'ink';
import { Agent } from '../agent/agent.js';
import { DEFAULT_MODEL } from '../model/llm.js';
import { reducer, initialState } from './reducer.js';
import { Header } from './components/header.js';
import { PlanPanel } from './components/plan-panel.js';
import { ToolsPanel } from './components/tools-panel.js';
import { OutputBox } from './components/output-box.js';
import { Footer } from './components/footer.js';
import { InputBar } from './components/input-bar.js';

const MAX_ITERATIONS = 10;

export const App: React.FC = () => {
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [state, dispatch] = useReducer(reducer, initialState(''));

  const handleSubmit = (q: string) => {
    setSubmittedQuery(q);
  };

  useEffect(() => {
    if (!submittedQuery) return;

    let cancelled = false;

    const run = async () => {
      const agent = await Agent.create({ usePlanner: true });
      if (cancelled) return;

      for await (const event of agent.run(submittedQuery)) {
        if (cancelled) break;
        dispatch(event);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [submittedQuery]);

  // Idle state — no query submitted yet
  if (!submittedQuery) {
    return (
      <Box flexDirection="column" height="100%">
        <Header mode="idle" model={DEFAULT_MODEL} />
        <Box flexGrow={1} paddingY={1}>
          <Box flexDirection="column">
            <Text>Dexter Pro — autonomous financial research agent</Text>
            <Text color="gray">Enter a financial research question below.</Text>
          </Box>
        </Box>
        <Footer
          tokens={state.tokens}
          iteration={state.iteration}
          elapsed={state.elapsed}
          plan={state.plan}
          maxIterations={MAX_ITERATIONS}
        />
        <InputBar onSubmit={handleSubmit} disabled={false} />
      </Box>
    );
  }

  // Active state — agent is or was running
  return (
    <Box flexDirection="column" height="100%">
      <Header mode={state.mode} model={DEFAULT_MODEL} />
      {state.plan?.visible && <PlanPanel plan={state.plan} />}
      <ToolsPanel tools={state.tools} />
      <OutputBox output={state.output} thinkingText={state.thinkingText} />
      <Footer
        tokens={state.tokens}
        iteration={state.iteration}
        elapsed={state.elapsed}
        plan={state.plan}
        maxIterations={MAX_ITERATIONS}
      />
      <InputBar onSubmit={handleSubmit} disabled={state.running} />
    </Box>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/app.tsx
git commit -m "feat: add App component — agent-driven useReducer loop"
```

---

### Task 10: Entry Point

**Files:**
- Modify: `src/index.tsx`

- [ ] **Step 1: Replace the stub entry point**

`src/index.tsx`:
```typescript
#!/usr/bin/env bun
import { config } from 'dotenv';
config({ quiet: true });

import React from 'react';
import { render } from 'ink';
import { App } from './ui/app.js';

const { unmount } = render(
  React.createElement(App),
  { exitOnCtrlC: true },
);

// Cleanup on unmount
process.on('exit', () => {
  unmount();
});
```

- [ ] **Step 2: Commit**

```bash
git add src/index.tsx
git commit -m "feat: wire up App component as entry point"
```

---

### Task 11: Integration Verification

**Files:**
- Create: `src/verify-phase6.ts`

- [ ] **Step 1: Write verification script**

`src/verify-phase6.ts`:
```typescript
#!/usr/bin/env bun
import { config } from 'dotenv';
config({ quiet: true });

import React from 'react';
import { render } from 'ink';
import { App } from './ui/app.js';

if (!process.env.DEEPSEEK_API_KEY?.startsWith('sk-')) {
  console.error('DEEPSEEK_API_KEY is not set or invalid.');
  process.exit(1);
}

console.log('Starting Dexter Pro CLI UI...');
console.log('Type a query and press Enter. Press Ctrl+C to exit.\n');

const { unmount } = render(React.createElement(App), {
  exitOnCtrlC: true,
});

process.on('exit', () => unmount());
```

- [ ] **Step 2: Run verification**

```bash
bun run typecheck
```

Expected: 0 TypeScript errors.

- [ ] **Step 3: Add npm script**

Add to `package.json` scripts:
```json
"verify-phase6": "bun run src/verify-phase6.ts"
```

- [ ] **Step 4: Manual smoke test**

Run `bun start` and verify:
- Header shows "Dexter Pro" + model name
- Input bar shows `$ ` prompt
- Submit a query → streaming output appears
- Plan panel shows if planner triggers
- Tools panel shows tool calls
- Footer shows tokens/iter/time
- Ctrl+C exits cleanly

- [ ] **Step 5: Commit**

```bash
git add src/verify-phase6.ts package.json
git commit -m "feat: add Phase 6 integration verification script"
```

---

### Task 12: Final TypeCheck

- [ ] **Step 1: Run full typecheck**

```bash
bun run typecheck
```

Expected: 0 errors. Fix any type errors before proceeding.

- [ ] **Step 2: Commit any fixes**

```bash
git add -A && git commit -m "fix: resolve typecheck errors from Phase 6 integration"
```

---

## Self-Review Checklist

1. **Spec coverage**: Each spec section maps to a task — Header (T3), PlanPanel (T4), ToolsPanel (T5), OutputBox (T6), Footer (T7), InputBar (T8), wiring (T9/T10). Table renderer is T1, reducer is T2. All covered.

2. **Placeholder scan**: No TBD/TODO. All code is complete. No "add appropriate error handling" without specific code.

3. **Type consistency**: `UIState` defined in T2 is used across all component tasks (T3-T9). `UIMode` type used in Header and reducer. `ToolEntry`, `PlanState` used consistently.
