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
