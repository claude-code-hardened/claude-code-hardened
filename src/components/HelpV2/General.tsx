import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js';
import { t } from '../../i18n/index.js';

export function General(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      <Box flexDirection="column" gap={1}>
        <Text bold>{t('Getting started')}</Text>
        <Box flexDirection="column">
          <Text>
            <Text bold>1. </Text>
            <Text>{t('Ask a question or describe a task — Claude will explore your code and respond.')}</Text>
          </Text>
          <Text>
            <Text bold>2. </Text>
            <Text>{t('When Claude wants to edit files or run commands, you review and approve each action.')}</Text>
          </Text>
          <Text>
            <Text bold>3. </Text>
            <Text>{t('Type ')}</Text>
            <Text bold>/commit</Text>
            <Text>{t(' to commit changes, ')}</Text>
            <Text bold>/help</Text>
            <Text>{t(' for commands, or ')}</Text>
            <Text bold>?</Text>
            <Text>{t(' for shortcuts.')}</Text>
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text bold>{t('Shortcuts')}</Text>
        </Box>
        <PromptInputHelpMenu gap={2} fixedWidth={true} />
      </Box>
    </Box>
  );
}
