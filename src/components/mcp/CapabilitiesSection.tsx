import React from 'react';
import { t } from '../../i18n/index.js';
import { Box, Text } from '@anthropic/ink';
import { Byline } from '@anthropic/ink';

type Props = {
  serverToolsCount: number;
  serverPromptsCount: number;
  serverResourcesCount: number;
};

export function CapabilitiesSection({
  serverToolsCount,
  serverPromptsCount,
  serverResourcesCount,
}: Props): React.ReactNode {
  const capabilities = [];
  if (serverToolsCount > 0) {
    capabilities.push(t('tools'));
  }
  if (serverResourcesCount > 0) {
    capabilities.push(t('resources'));
  }
  if (serverPromptsCount > 0) {
    capabilities.push(t('prompts'));
  }

  return (
    <Box>
      <Text bold>{t('Capabilities: ')}</Text>
      <Text color="text">{capabilities.length > 0 ? <Byline>{capabilities}</Byline> : t('none')}</Text>
    </Box>
  );
}
