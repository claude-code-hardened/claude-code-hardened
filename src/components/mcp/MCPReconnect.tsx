import figures from 'figures';
import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Box, color, Text, useTheme } from '@anthropic/ink';
import { useMcpReconnect } from '../../services/mcp/MCPConnectionManager.js';
import { t } from '../../i18n/index.js';
import { useAppStateStore } from '../../state/AppState.js';
import { Spinner } from '../Spinner.js';

type Props = {
  serverName: string;
  onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

export function MCPReconnect({ serverName, onComplete }: Props): React.ReactNode {
  const [theme] = useTheme();
  const store = useAppStateStore();
  const reconnectMcpServer = useMcpReconnect();
  const [isReconnecting, setIsReconnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function attemptReconnect() {
      try {
        // Check if server exists. Read via store.getState() instead of a
        // reactive selector so this effect does not re-fire when
        // reconnectMcpServer updates mcp.clients via onConnectionAttempt.
        const server = store.getState().mcp.clients.find(c => c.name === serverName);
        if (!server) {
          setError(t('MCP server "{{name}}" not found', { name: serverName }));
          setIsReconnecting(false);
          onComplete(t('MCP server "{{name}}" not found', { name: serverName }));
          return;
        }

        // Attempt reconnection
        const result = await reconnectMcpServer(serverName);

        switch (result.client.type) {
          case 'connected':
            setIsReconnecting(false);
            onComplete(t('Successfully reconnected to {{name}}', { name: serverName }));
            break;
          case 'needs-auth':
            setError(t('{{name}} requires authentication', { name: serverName }));
            setIsReconnecting(false);
            onComplete(t('{{name}} requires authentication. Use /mcp to authenticate.', { name: serverName }));
            break;
          case 'pending':
          case 'failed':
          case 'disabled':
            setError(t('Failed to reconnect to {{name}}', { name: serverName }));
            setIsReconnecting(false);
            onComplete(t('Failed to reconnect to {{name}}', { name: serverName }));
            break;
        }
      } catch (err) {
        // Only catch actual errors (like server not found)
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        setIsReconnecting(false);
        onComplete(t('Error: {{error}}', { error: errorMessage }));
      }
    }

    void attemptReconnect();
  }, [serverName, reconnectMcpServer, store, onComplete]);

  if (isReconnecting) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="text">
          {t('Reconnecting to')} <Text bold>{serverName}</Text>
        </Text>
        <Box>
          <Spinner />
          <Text>{t(' Establishing connection to MCP server')}</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Box>
          <Text>{color('error', theme)(figures.cross)} </Text>
          <Text color="error">{t('Failed to reconnect to {{name}}', { name: serverName })}</Text>
        </Box>
        <Text dimColor>{t('Error: {{error}}', { error })}</Text>
      </Box>
    );
  }

  return null;
}
