import { feature } from 'bun:bundle';
import * as React from 'react';
import { resetCostState } from '../../bootstrap/state.js';
import { clearTrustedDeviceToken, enrollTrustedDevice } from '../../bridge/trustedDevice.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js';
import { Box, Dialog, useInput } from '@anthropic/ink';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import TextInput from '../../components/TextInput.js';
import { Text } from '@anthropic/ink';
import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { refreshPolicyLimits } from '../../services/policyLimits/index.js';
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { stripSignatureBlocks } from '../../utils/messages.js';
import {
  checkAndDisableAutoModeIfNeeded,
  resetAutoModeGateCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js';
import { resetUserCache } from '../../utils/user.js';
import { AuthPlaneSummary } from './AuthPlaneSummary.js';
import { getAuthStatus } from './getAuthStatus.js';
import { WorkspaceKeyInputContainer } from './WorkspaceKeyInput.js';
import { removeWorkspaceKey } from '../../services/auth/saveWorkspaceKey.js';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  // Snapshot auth state once at call time (pure, no network)
  const authStatus = getAuthStatus();

  return (
    <Login
      authStatus={authStatus}
      onDone={async success => {
        context.onChangeAPIKey();
        // Signature-bearing blocks (thinking, connector_text) are bound to the API key —
        // strip them so the new key doesn't reject stale signatures.
        context.setMessages(stripSignatureBlocks);
        if (success) {
          // Post-login refresh logic. Keep in sync with onboarding in src/interactiveHelpers.tsx
          // Reset cost state when switching accounts
          resetCostState();
          // Refresh remotely managed settings after login (non-blocking)
          void refreshRemoteManagedSettings();
          // Refresh policy limits after login (non-blocking)
          void refreshPolicyLimits();
          // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
          resetUserCache();
          // Refresh GrowthBook after login to get updated feature flags (e.g., for claude.ai MCPs)
          refreshGrowthBookAfterAuthChange();
          // Clear any stale trusted device token from a previous account before
          // re-enrolling — prevents sending the old token on bridge calls while
          // the async enrollTrustedDevice() is in-flight.
          clearTrustedDeviceToken();
          // Enroll as a trusted device for Remote Control (10-min fresh-session window)
          void enrollTrustedDevice();
          // Reset killswitch gate checks and re-run with new org
          resetAutoModeGateCheck();
          const appState = context.getAppState();
          void checkAndDisableAutoModeIfNeeded(appState.toolPermissionContext, context.setAppState, appState.fastMode);
          // Increment authVersion to trigger re-fetching of auth-dependent data in hooks (e.g., MCP servers)
          context.setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }));
        }
        onDone(success ? 'Login successful' : 'Login interrupted');
      }}
    />
  );
}

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void;
  startingMessage?: string;
  /** Pre-computed auth status snapshot — passed from call() to avoid re-computing */
  authStatus?: import('./getAuthStatus.js').AuthStatus;
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel();
  const [showWorkspaceKeyInput, setShowWorkspaceKeyInput] = React.useState(false);
  // Set once ConsoleOAuthFlow reports success; /login then offers an optional
  // per-model context window override before completing.
  const [pendingSuccess, setPendingSuccess] = React.useState(false);
  const [showContextPrompt, setShowContextPrompt] = React.useState(false);
  const [contextInput, setContextInput] = React.useState('');
  const [contextCursorOffset, setContextCursorOffset] = React.useState(0);
  const terminalSize = useTerminalSize();
  // 'idle' | 'confirm-remove' | 'removing' | { error: string }
  const [removeState, setRemoveState] = React.useState<
    { phase: 'idle' } | { phase: 'confirm-remove' } | { phase: 'removing' } | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  // Re-snapshot auth status after a key is saved/removed so the row updates immediately
  const [liveAuthStatus, setLiveAuthStatus] = React.useState(props.authStatus);

  const workspaceKeySet = liveAuthStatus !== undefined && liveAuthStatus.workspaceKey.set;
  // Source distinguishes env-var (cannot be deleted from UI) vs settings-saved
  const workspaceKeyFromSettings = workspaceKeySet && liveAuthStatus.workspaceKey.source === 'settings';

  const refreshLiveStatus = React.useCallback(() => {
    const { getAuthStatus } = require('./getAuthStatus.js') as typeof import('./getAuthStatus.js');
    setLiveAuthStatus(getAuthStatus());
  }, []);

  // W = enter/replace key; D = delete (only when stored in settings)
  useInput(
    (input: string) => {
      if (showWorkspaceKeyInput) return;
      if (removeState.phase === 'confirm-remove') {
        if (input === 'y' || input === 'Y') {
          setRemoveState({ phase: 'removing' });
          void (async () => {
            try {
              await removeWorkspaceKey();
              refreshLiveStatus();
              setRemoveState({ phase: 'idle' });
            } catch (err) {
              setRemoveState({
                phase: 'error',
                message: err instanceof Error ? err.message : 'Failed to remove workspace API key',
              });
            }
          })();
          return;
        }
        if (input === 'n' || input === 'N') {
          setRemoveState({ phase: 'idle' });
          return;
        }
        return;
      }
      if (input === 'w' || input === 'W') {
        setShowWorkspaceKeyInput(true);
        return;
      }
      if ((input === 'd' || input === 'D') && workspaceKeyFromSettings) {
        setRemoveState({ phase: 'confirm-remove' });
      }
    },
    { isActive: !showWorkspaceKeyInput && !showContextPrompt },
  );

  const handleWorkspaceKeySaved = React.useCallback(() => {
    refreshLiveStatus();
    setShowWorkspaceKeyInput(false);
  }, [refreshLiveStatus]);

  const handleWorkspaceKeyCancel = React.useCallback(() => {
    setShowWorkspaceKeyInput(false);
  }, []);

  const finishLogin = React.useCallback(
    (success: boolean) => {
      props.onDone(success, mainLoopModel);
    },
    [props.onDone, mainLoopModel],
  );

  // Enter at the context-window prompt: a positive integer persists the
  // override for the current model (merged with existing overrides); empty or
  // invalid input skips. Login completes either way.
  const handleContextSubmit = React.useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          const existing = getInitialSettings().contextWindowOverrides ?? {};
          updateSettingsForSource('userSettings', {
            contextWindowOverrides: { ...existing, [mainLoopModel]: parsed },
          });
        }
      }
      finishLogin(true);
    },
    [finishLogin, mainLoopModel],
  );

  return (
    <Dialog
      title="Login"
      onCancel={() => {
        if (showContextPrompt) {
          // Login already succeeded — Esc at the optional prompt just skips
          // the override and completes /login.
          finishLogin(pendingSuccess);
          return;
        }
        props.onDone(false, mainLoopModel);
      }}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
        )
      }
    >
      <Box flexDirection="column">
        {liveAuthStatus !== undefined && (
          <Box marginBottom={1}>
            <AuthPlaneSummary status={liveAuthStatus} />
          </Box>
        )}

        {showContextPrompt ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>
              Optionally customize the context window for this model. Useful when a third-party/proxy model&apos;s true
              context differs from the built-in detection (affects auto-compact thresholds and context % display).
            </Text>
            <Box marginTop={1}>
              <Text>Context window tokens for {mainLoopModel} (empty = skip):</Text>
            </Box>
            <TextInput
              value={contextInput}
              onChange={setContextInput}
              onSubmit={handleContextSubmit}
              onExit={() => handleContextSubmit(contextInput)}
              focus={true}
              placeholder="e.g. 500000"
              columns={terminalSize.columns}
              cursorOffset={contextCursorOffset}
              onChangeCursorOffset={setContextCursorOffset}
              showCursor={true}
            />
          </Box>
        ) : showWorkspaceKeyInput ? (
          <WorkspaceKeyInputContainer onSaved={handleWorkspaceKeySaved} onCancel={handleWorkspaceKeyCancel} />
        ) : removeState.phase === 'confirm-remove' || removeState.phase === 'removing' ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              Remove the saved workspace API key? <Text dimColor>(settings.json only — env var is unaffected)</Text>
            </Text>
            <Text dimColor>{removeState.phase === 'removing' ? 'Removing…' : 'Press Y to confirm, N to cancel'}</Text>
          </Box>
        ) : (
          <>
            <Box flexDirection="column" marginBottom={1}>
              {!workspaceKeySet ? (
                <Text dimColor>Press W to enter workspace API key (saves to settings, no restart needed)</Text>
              ) : workspaceKeyFromSettings ? (
                <Text dimColor>Press W to replace workspace API key · Press D to remove it</Text>
              ) : (
                <Text dimColor>
                  Workspace API key from ANTHROPIC_API_KEY env. Press W to override with a settings-saved key.
                </Text>
              )}
              {removeState.phase === 'error' && <Text color="error">{removeState.message}</Text>}
            </Box>
            <ConsoleOAuthFlow
              onDone={() => {
                // Login succeeded — offer the optional per-model context
                // window override before completing /login (skippable via
                // empty input).
                setPendingSuccess(true);
                setShowContextPrompt(true);
              }}
              startingMessage={props.startingMessage}
            />
          </>
        )}
      </Box>
    </Dialog>
  );
}
