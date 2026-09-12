import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';

type Props = {
  addMargin: boolean;
};

export function AssistantRedactedThinkingMessage({ addMargin = false }: Props): React.ReactNode {
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text dimColor italic>
        {t('✻ Thinking…')}
      </Text>
    </Box>
  );
}
