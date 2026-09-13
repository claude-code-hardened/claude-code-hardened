import { feature } from 'bun:bundle';
import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, usePreviewTheme, useTheme, useThemeSetting } from '@anthropic/ink';
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { gracefulShutdown } from '../utils/gracefulShutdown.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import type { ThemeSetting } from '../utils/theme.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { getColorModuleUnavailableReason, getSyntaxTheme } from './StructuredDiff/colorDiff.js';
import { StructuredDiff } from './StructuredDiff.js';
import { t } from '../i18n/index.js';

export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void;
  showIntroText?: boolean;
  helpText?: string;
  showHelpTextBelow?: boolean;
  hideEscToCancel?: boolean;
  /** Skip exit handling when running in a context that already has it (e.g., onboarding) */
  skipExitHandling?: boolean;
  /** Called when the user cancels (presses Escape). If skipExitHandling is true and this is provided, it will be called instead of just saving the preview. */
  onCancel?: () => void;
};

export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText = '',
  showHelpTextBelow = false,
  hideEscToCancel = false,
  skipExitHandling = false,
  onCancel: onCancelProp,
}: ThemePickerProps): React.ReactNode {
  const [theme] = useTheme();
  const themeSetting = useThemeSetting();
  const { columns } = useTerminalSize();
  const colorModuleUnavailableReason = getColorModuleUnavailableReason();
  const syntaxTheme = colorModuleUnavailableReason === null ? getSyntaxTheme(theme) : null;
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme();
  const syntaxHighlightingDisabled = useAppState(s => s.settings.syntaxHighlightingDisabled) ?? false;
  const setAppState = useSetAppState();

  // Register ThemePicker context so its keybindings take precedence over Global
  useRegisterKeybindingContext('ThemePicker');

  const syntaxToggleShortcut = useShortcutDisplay('theme:toggleSyntaxHighlighting', 'ThemePicker', 'ctrl+t');

  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      if (colorModuleUnavailableReason === null) {
        const newValue = !syntaxHighlightingDisabled;
        updateSettingsForSource('userSettings', {
          syntaxHighlightingDisabled: newValue,
        });
        setAppState(prev => ({
          ...prev,
          settings: { ...prev.settings, syntaxHighlightingDisabled: newValue },
        }));
      }
    },
    { context: 'ThemePicker' },
  );
  // Always call the hook to follow React rules, but conditionally assign the exit handler
  const exitState = useExitOnCtrlCDWithKeybindings(skipExitHandling ? () => {} : undefined);

  const themeOptions: { label: string; value: ThemeSetting }[] = [
    ...(feature('AUTO_THEME') ? [{ label: t('Auto (match terminal)'), value: 'auto' as const }] : []),
    { label: t('Dark mode'), value: 'dark' },
    { label: t('Light mode'), value: 'light' },
    {
      label: t('Dark mode (colorblind-friendly)'),
      value: 'dark-daltonized',
    },
    {
      label: t('Light mode (colorblind-friendly)'),
      value: 'light-daltonized',
    },
    {
      label: t('Dark mode (ANSI colors only)'),
      value: 'dark-ansi',
    },
    {
      label: t('Light mode (ANSI colors only)'),
      value: 'light-ansi',
    },
  ];

  const content = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        {showIntroText ? (
          <Text>{t("Let's get started.")}</Text>
        ) : (
          <Text bold color="permission">
            {t('Theme')}
          </Text>
        )}
        <Box flexDirection="column">
          <Text bold>{t('Choose the text style that looks best with your terminal')}</Text>
          {helpText && !showHelpTextBelow && <Text dimColor>{helpText}</Text>}
        </Box>
        <Select
          options={themeOptions}
          onFocus={setting => {
            setPreviewTheme(setting as ThemeSetting);
          }}
          onChange={(setting: string) => {
            savePreview();
            onThemeSelect(setting as ThemeSetting);
          }}
          onCancel={
            skipExitHandling
              ? () => {
                  cancelPreview();
                  onCancelProp?.();
                }
              : async () => {
                  cancelPreview();
                  await gracefulShutdown(0);
                }
          }
          visibleOptionCount={themeOptions.length}
          defaultValue={themeSetting}
          defaultFocusValue={themeSetting}
        />
      </Box>
      <Box flexDirection="column" width="100%">
        <Box
          flexDirection="column"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          borderStyle="dashed"
          borderColor="subtle"
        >
          <StructuredDiff
            patch={{
              oldStart: 1,
              newStart: 1,
              oldLines: 3,
              newLines: 3,
              lines: [
                ' function greet() {',
                '-  console.log("Hello, World!");',
                '+  console.log("Hello, Claude!");',
                ' }',
              ],
            }}
            dim={false}
            filePath="demo.js"
            firstLine={null}
            width={columns}
          />
        </Box>
        <Text dimColor>
          {' '}
          {colorModuleUnavailableReason === 'env'
            ? t('Syntax highlighting disabled (via CLAUDE_CODE_SYNTAX_HIGHLIGHT={{v}})', {
                v: process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT,
              })
            : syntaxHighlightingDisabled
              ? t('Syntax highlighting disabled ({{k}} to enable)', { k: syntaxToggleShortcut })
              : syntaxTheme
                ? t('Syntax theme: {{t}}{{s}} ({{k}} to disable)', {
                    t: syntaxTheme.theme,
                    s: syntaxTheme.source ? t(' (from {{v}})', { v: syntaxTheme.source }) : '',
                    k: syntaxToggleShortcut,
                  })
                : t('Syntax highlighting enabled ({{k}} to disable)', { k: syntaxToggleShortcut })}
        </Text>
      </Box>
    </Box>
  );

  // Only wrap in a box when not in onboarding
  if (!showIntroText) {
    return (
      <>
        <Box flexDirection="column">{content}</Box>
        <Box marginTop={1}>
          {showHelpTextBelow && helpText && (
            <Box marginLeft={3}>
              <Text dimColor>{helpText}</Text>
            </Box>
          )}
          {!hideEscToCancel && (
            <Box>
              <Text dimColor italic>
                {exitState.pending ? (
                  <>{t('Press {{k}} again to exit', { k: exitState.keyName })}</>
                ) : (
                  <Byline>
                    <KeyboardShortcutHint shortcut="Enter" action="select" />
                    <KeyboardShortcutHint shortcut="Esc" action="cancel" />
                  </Byline>
                )}
              </Text>
            </Box>
          )}
        </Box>
      </>
    );
  }

  return content;
}
