import figures from 'figures';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Box, color, Link, Text, useTheme } from '@anthropic/ink';
import { t } from '../../i18n/index.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { AuthenticationCancelledError, performMCPOAuthFlow } from '../../services/mcp/auth.js';
import { capitalize } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Select } from '../CustomSelect/index.js';
import { Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';
import { Spinner } from '../Spinner.js';
import type { AgentMcpServerInfo } from './types.js';

type Props = {
  agentServer: AgentMcpServerInfo;
  onCancel: () => void;
  onComplete?: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

/**
 * Menu for agent-specific MCP servers.
 * These servers are defined in agent frontmatter and only connect when the agent runs.
 * For HTTP/SSE servers, this allows pre-authentication before using the agent.
 */
export function MCPAgentServerMenu({ agentServer, onCancel, onComplete }: Props): React.ReactNode {
  const [theme] = useTheme();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const authAbortControllerRef = useRef<AbortController | null>(null);

  // Abort OAuth flow on unmount so the callback server is closed even if a
  // parent component's Esc handler navigates away before ours fires.
  useEffect(() => () => authAbortControllerRef.current?.abort(), []);

  // Handle ESC to cancel authentication flow
  const handleEscCancel = useCallback(() => {
    if (isAuthenticating) {
      authAbortControllerRef.current?.abort();
      authAbortControllerRef.current = null;
      setIsAuthenticating(false);
      setAuthorizationUrl(null);
    }
  }, [isAuthenticating]);

  useKeybinding('confirm:no', handleEscCancel, {
    context: 'Confirmation',
    isActive: isAuthenticating,
  });

  const handleAuthenticate = useCallback(async () => {
    if (!agentServer.needsAuth || !agentServer.url) {
      return;
    }

    setIsAuthenticating(true);
    setError(null);

    const controller = new AbortController();
    authAbortControllerRef.current = controller;

    try {
      // Create a temporary config for OAuth
      const tempConfig = {
        type: agentServer.transport as 'http' | 'sse',
        url: agentServer.url,
      };

      await performMCPOAuthFlow(agentServer.name, tempConfig, setAuthorizationUrl, controller.signal);

      onComplete?.(
        t('Authentication successful for {{name}}. The server will connect when the agent runs.', {
          name: agentServer.name,
        }),
      );
    } catch (err) {
      // Don't show error if it was a cancellation
      if (err instanceof Error && !(err instanceof AuthenticationCancelledError)) {
        setError(err.message);
      }
    } finally {
      setIsAuthenticating(false);
      authAbortControllerRef.current = null;
    }
  }, [agentServer, onComplete]);

  const capitalizedServerName = capitalize(String(agentServer.name));

  if (isAuthenticating) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="claude">{t('Authenticating with {{name}}…', { name: agentServer.name })}</Text>
        <Box>
          <Spinner />
          <Text>{t(' A browser window will open for authentication')}</Text>
        </Box>
        {authorizationUrl && (
          <Box flexDirection="column">
            <Text dimColor>{t("If your browser doesn't open automatically, copy this URL manually:")}</Text>
            <Link url={authorizationUrl} />
          </Box>
        )}
        <Box marginLeft={3}>
          <Text dimColor>
            {t('Return here after authenticating in your browser.')}{' '}
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
          </Text>
        </Box>
      </Box>
    );
  }

  const menuOptions = [];

  // Only show authenticate option for HTTP/SSE servers
  if (agentServer.needsAuth) {
    menuOptions.push({
      label: agentServer.isAuthenticated ? t('Re-authenticate') : t('Authenticate'),
      value: 'auth',
    });
  }

  menuOptions.push({
    label: t('Back'),
    value: 'back',
  });

  return (
    <Dialog
      title={t('{{name}} MCP Server', { name: capitalizedServerName })}
      subtitle={t('agent-only')}
      onCancel={onCancel}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>{t('Press {{keyName}} again to exit', { keyName: exitState.keyName })}</Text>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
          </Byline>
        )
      }
    >
      <Box flexDirection="column" gap={0}>
        <Box>
          <Text bold>{t('Type: ')}</Text>
          <Text dimColor>{agentServer.transport}</Text>
        </Box>

        {agentServer.url && (
          <Box>
            <Text bold>{t('URL: ')}</Text>
            <Text dimColor>{agentServer.url}</Text>
          </Box>
        )}

        {agentServer.command && (
          <Box>
            <Text bold>{t('Command: ')}</Text>
            <Text dimColor>{agentServer.command}</Text>
          </Box>
        )}

        <Box>
          <Text bold>{t('Used by: ')}</Text>
          <Text dimColor>{agentServer.sourceAgents.join(', ')}</Text>
        </Box>

        <Box marginTop={1}>
          <Text bold>{t('Status: ')}</Text>
          <Text>
            {color('inactive', theme)(figures.radioOff)} {t('not connected (agent-only)')}
          </Text>
        </Box>

        {agentServer.needsAuth && (
          <Box>
            <Text bold>{t('Auth: ')}</Text>
            {agentServer.isAuthenticated ? (
              <Text>
                {color('success', theme)(figures.tick)} {t('authenticated')}
              </Text>
            ) : (
              <Text>
                {color('warning', theme)(figures.triangleUpOutline)} {t('may need authentication')}
              </Text>
            )}
          </Box>
        )}
      </Box>

      <Box>
        <Text dimColor>{t('This server connects only when running the agent.')}</Text>
      </Box>

      {error && (
        <Box>
          <Text color="error">{t('Error: {{error}}', { error })}</Text>
        </Box>
      )}

      <Box>
        <Select
          options={menuOptions}
          onChange={async value => {
            switch (value) {
              case 'auth':
                await handleAuthenticate();
                break;
              case 'back':
                onCancel();
                break;
            }
          }}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  );
}
