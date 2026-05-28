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
