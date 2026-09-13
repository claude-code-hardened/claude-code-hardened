import { type ReactNode } from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '@anthropic/ink';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { t } from '../../i18n/index.js';

type Props = {
  instructions?: ReactNode;
};

export function WizardNavigationFooter({
  instructions = (
    <Byline>
      <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
      <KeyboardShortcutHint shortcut="Enter" action="select" />
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
    </Byline>
  ),
}: Props): ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings();

  return (
    <Box marginLeft={3} marginTop={1}>
      <Text dimColor>
        {exitState.pending ? t('Press {{k}} again to exit', { k: exitState.keyName }) : instructions}
      </Text>
    </Box>
  );
}
