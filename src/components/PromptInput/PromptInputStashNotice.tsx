import figures from 'figures';
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';

type Props = {
  hasStash: boolean;
};

export function PromptInputStashNotice({ hasStash }: Props): React.ReactNode {
  if (!hasStash) {
    return null;
  }

  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        {figures.pointerSmall} {t('Stashed (auto-restores after submit)')}
      </Text>
    </Box>
  );
}
