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
