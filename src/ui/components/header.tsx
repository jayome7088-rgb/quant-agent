import React from 'react';
import { Box, Text } from 'ink';
import type { UIMode } from '../reducer.js';

const MODE_CONFIG: Record<UIMode, { icon: string; color: string; label: string }> = {
  idle:       { icon: '◇', color: 'gray',   label: 'idle' },
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
        <Text bold color="cyan">QuantAgent</Text>
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
