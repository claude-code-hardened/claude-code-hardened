import figures from 'figures';
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';
import { getPluginTrustMessage } from '../../utils/plugins/marketplaceHelpers.js';

export function PluginTrustWarning(): React.ReactNode {
  const customMessage = getPluginTrustMessage();
  return (
    <Box marginBottom={1}>
      <Text color="claude">{figures.warning} </Text>
      <Text dimColor italic>
        {t(
          "Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change. See each plugin's homepage for more information.",
        )}
        {customMessage ? ` ${customMessage}` : ''}
      </Text>
    </Box>
  );
}
