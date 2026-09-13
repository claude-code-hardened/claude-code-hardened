import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';

type Props = {
  instructions?: string;
};

export function AgentNavigationFooter({ instructions }: Props): React.ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings();
  const resolvedInstructions = instructions ?? t('Press ↑↓ to navigate · Enter to select · Esc to go back');

  return (
    <Box marginLeft={2}>
      <Text dimColor>
        {exitState.pending ? t('Press {{k}} again to exit', { k: exitState.keyName }) : resolvedInstructions}
      </Text>
    </Box>
  );
}
