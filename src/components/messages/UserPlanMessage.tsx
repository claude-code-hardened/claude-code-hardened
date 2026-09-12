import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';
import { Markdown } from '../Markdown.js';

type Props = {
  addMargin: boolean;
  planContent: string;
};

export function UserPlanMessage({ addMargin, planContent }: Props): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="planMode" marginTop={addMargin ? 1 : 0} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="planMode">
          {t('Plan to implement')}
        </Text>
      </Box>
      <Markdown>{planContent}</Markdown>
    </Box>
  );
}
