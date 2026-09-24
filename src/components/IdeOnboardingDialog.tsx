import React from 'react';
import { envDynamic } from 'src/utils/envDynamic.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { env } from '../utils/env.js';
import {
  getTerminalIdeType,
  type IDEExtensionInstallationStatus,
  isJetBrainsIde,
  toIDEDisplayName,
} from '../utils/ide.js';
import { Dialog } from '@anthropic/ink';
import { t } from 'src/i18n/index.js';

interface Props {
  onDone: () => void;
  installationStatus: IDEExtensionInstallationStatus | null;
}

export function IdeOnboardingDialog({ onDone, installationStatus }: Props): React.ReactNode {
  markDialogAsShown();

  // Handle Enter/Escape to dismiss
  useKeybindings(
    {
      'confirm:yes': onDone,
      'confirm:no': onDone,
    },
    { context: 'Confirmation' },
  );

  const ideType = installationStatus?.ideType ?? getTerminalIdeType();
  const isJetBrains = isJetBrainsIde(ideType);

  const ideName = toIDEDisplayName(ideType);
  const installedVersion = installationStatus?.installedVersion;
  const pluginOrExtension = isJetBrains ? 'plugin' : 'extension';
  const mentionShortcut = env.platform === 'darwin' ? 'Cmd+Option+K' : 'Ctrl+Alt+K';

  return (
    <>
      <Dialog
        title={
          <>
            <Text color="claude">✻ </Text>
            <Text>{t('Welcome to Claude Code for {{ideName}}', { ideName })}</Text>
          </>
        }
        subtitle={
          installedVersion
            ? t('installed {{kind}} v{{version}}', { kind: pluginOrExtension, version: installedVersion })
            : undefined
        }
        color="ide"
        onCancel={onDone}
        hideInputGuide
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            {`• ${t('Claude has context of')} `}
            <Text color="suggestion">{`⧉ ${t('open files')}`}</Text>
            {` ${t('and')} `}
            <Text color="suggestion">{`⧉ ${t('selected lines')}`}</Text>
          </Text>
          <Text>
            {`• ${t("Review Claude Code's changes")} `}
            <Text color="diffAddedWord">+11</Text> <Text color="diffRemovedWord">-22</Text>{' '}
            {t('in the comfort of your IDE')}
          </Text>
          <Text>
            • Cmd+Esc<Text dimColor>{` ${t('for Quick Launch')}`}</Text>
          </Text>
          <Text>
            • {mentionShortcut}
            <Text dimColor>{` ${t('to reference files or lines in your input')}`}</Text>
          </Text>
        </Box>
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor italic>
          {t('Press Enter to continue')}
        </Text>
      </Box>
    </>
  );
}

export function hasIdeOnboardingDialogBeenShown(): boolean {
  const config = getGlobalConfig();
  const terminal = envDynamic.terminal || 'unknown';
  return config.hasIdeOnboardingBeenShown?.[terminal] === true;
}

function markDialogAsShown(): void {
  if (hasIdeOnboardingDialogBeenShown()) {
    return;
  }
  const terminal = envDynamic.terminal || 'unknown';
  saveGlobalConfig(current => ({
    ...current,
    hasIdeOnboardingBeenShown: {
      ...current.hasIdeOnboardingBeenShown,
      [terminal]: true,
    },
  }));
}
