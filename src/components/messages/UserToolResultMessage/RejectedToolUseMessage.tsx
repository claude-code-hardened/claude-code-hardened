import * as React from 'react';
import { Text } from '@anthropic/ink';
import { t } from '../../../i18n/index.js';
import { MessageResponse } from '../../MessageResponse.js';

export function RejectedToolUseMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>{t('Tool use rejected')}</Text>
    </MessageResponse>
  );
}
