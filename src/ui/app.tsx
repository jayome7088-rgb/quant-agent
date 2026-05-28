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

  // Idle state -- no query submitted yet
  if (!submittedQuery) {
    return (
      <Box flexDirection="column" height="100%">
        <Header mode="idle" model={DEFAULT_MODEL} />
        <Box flexGrow={1} paddingY={1}>
          <Box flexDirection="column">
            <Text>Dexter Pro -- autonomous financial research agent</Text>
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

  // Active state -- agent is or was running
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
