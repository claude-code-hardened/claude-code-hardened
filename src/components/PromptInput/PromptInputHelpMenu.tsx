import { feature } from 'bun:bundle';
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';
import { getPlatform } from 'src/utils/platform.js';
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { isFastModeAvailable, isFastModeEnabled } from '../../utils/fastMode.js';
import { getNewlineInstructions } from './utils.js';

/** Format a shortcut for display in the help menu (e.g., "ctrl+o" → "ctrl + o") */
function formatShortcut(shortcut: string): string {
  return shortcut.replace(/\+/g, ' + ');
}

type Props = {
  dimColor?: boolean;
  fixedWidth?: boolean;
  gap?: number;
  paddingX?: number;
};

export function PromptInputHelpMenu(props: Props): React.ReactNode {
  const { dimColor, fixedWidth, gap, paddingX } = props;

  // Get configured shortcuts from keybinding system
  const transcriptShortcut = formatShortcut(useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o'));
  const todosShortcut = formatShortcut(useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t'));
  const undoShortcut = formatShortcut(useShortcutDisplay('chat:undo', 'Chat', 'ctrl+_'));
  const stashShortcut = formatShortcut(useShortcutDisplay('chat:stash', 'Chat', 'ctrl+s'));
  const cycleModeShortcut = formatShortcut(useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab'));
  const modelPickerShortcut = formatShortcut(useShortcutDisplay('chat:modelPicker', 'Chat', 'alt+p'));
  const fastModeShortcut = formatShortcut(useShortcutDisplay('chat:fastMode', 'Chat', 'alt+o'));
  const externalEditorShortcut = formatShortcut(useShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+g'));
  const terminalShortcut = formatShortcut(useShortcutDisplay('app:toggleTerminal', 'Global', 'meta+j'));
  const imagePasteShortcut = formatShortcut(useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v'));

  // Compute terminal shortcut element outside JSX to satisfy feature() constraint
  const terminalShortcutElement = feature('TERMINAL_PANEL') ? (
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_panel', false) ? (
      <Box>
        <Text dimColor={dimColor}>{t('{{key}} for terminal', { key: terminalShortcut })}</Text>
      </Box>
    ) : null
  ) : null;

  return (
    <Box paddingX={paddingX} flexDirection="row" gap={gap}>
      <Box flexDirection="column" width={fixedWidth ? 24 : undefined}>
        <Box>
          <Text dimColor={dimColor}>{t('! for bash mode')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('/ for commands')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('@ for file paths')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('& for background')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('/btw for side question')}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" width={fixedWidth ? 35 : undefined}>
        <Box>
          <Text dimColor={dimColor}>{t('double tap esc to clear input')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {cycleModeShortcut} {process.env.USER_TYPE === 'ant' ? t('to cycle modes') : t('to auto-accept edits')}
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('{{key}} for verbose output', { key: transcriptShortcut })}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('{{key}} to toggle tasks', { key: todosShortcut })}</Text>
        </Box>
        {terminalShortcutElement}
        <Box>
          <Text dimColor={dimColor}>{getNewlineInstructions()}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text dimColor={dimColor}>{t('{{key}} to undo', { key: undoShortcut })}</Text>
        </Box>
        {getPlatform() !== 'windows' && (
          <Box>
            <Text dimColor={dimColor}>{t('ctrl + z to suspend')}</Text>
          </Box>
        )}
        <Box>
          <Text dimColor={dimColor}>{t('{{key}} to paste images', { key: imagePasteShortcut })}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('{{key}} to switch model', { key: modelPickerShortcut })}</Text>
        </Box>
        {isFastModeEnabled() && isFastModeAvailable() && (
          <Box>
            <Text dimColor={dimColor}>{t('{{key}} to toggle fast mode', { key: fastModeShortcut })}</Text>
          </Box>
        )}
        <Box>
          <Text dimColor={dimColor}>{t('{{key}} to stash prompt', { key: stashShortcut })}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{t('{{key}} to edit in $EDITOR', { key: externalEditorShortcut })}</Text>
        </Box>
        {isKeybindingCustomizationEnabled() && (
          <Box>
            <Text dimColor={dimColor}>{t('/keybindings to customize')}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
