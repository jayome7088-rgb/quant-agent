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
