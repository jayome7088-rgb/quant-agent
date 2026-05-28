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
