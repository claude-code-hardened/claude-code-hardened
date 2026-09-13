import React from 'react';
import { Box, color, Link, Text, useTheme, Pane, Tab, Tabs, useTabHeaderFocus } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import type { CommandResultDisplay } from '../../types/command.js';
import type { SandboxDependencyCheck } from '../../utils/sandbox/sandbox-adapter.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js';
import { Select } from '../CustomSelect/select.js';
import { SandboxConfigTab } from './SandboxConfigTab.js';
import { SandboxDependenciesTab } from './SandboxDependenciesTab.js';
import { SandboxOverridesTab } from './SandboxOverridesTab.js';
import { t } from '../../i18n/index.js';

type Props = {
  onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  depCheck: SandboxDependencyCheck;
};

type SandboxMode = 'auto-allow' | 'regular' | 'disabled';

export function SandboxSettings({ onComplete, depCheck }: Props): React.ReactNode {
  const [theme] = useTheme();
  const currentEnabled = SandboxManager.isSandboxingEnabled();
  const currentAutoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled();
  const hasWarnings = depCheck.warnings.length > 0;
  const settings = getSettings_DEPRECATED();
  const allowAllUnixSockets = settings.sandbox?.network?.allowAllUnixSockets;
  // Show warning if seccomp missing AND user hasn't allowed all unix sockets
  const showSocketWarning = hasWarnings && !allowAllUnixSockets;

  // Determine current mode
  const getCurrentMode = (): SandboxMode => {
    if (!currentEnabled) return 'disabled';
    if (currentAutoAllow) return 'auto-allow';
    return 'regular';
  };

  const currentMode = getCurrentMode();
  const currentIndicator = color('success', theme)(`(current)`);

  const options = [
    {
      label:
        currentMode === 'auto-allow'
          ? t('Sandbox BashTool, with auto-allow {{v}}', { v: currentIndicator })
          : t('Sandbox BashTool, with auto-allow'),
      value: 'auto-allow',
    },
    {
      label:
        currentMode === 'regular'
          ? t('Sandbox BashTool, with regular permissions {{v}}', { v: currentIndicator })
          : t('Sandbox BashTool, with regular permissions'),
      value: 'regular',
    },
    {
      label: currentMode === 'disabled' ? t('No Sandbox {{v}}', { v: currentIndicator }) : t('No Sandbox'),
      value: 'disabled',
    },
  ];

  async function handleSelect(value: string) {
    const mode = value as SandboxMode;

    switch (mode) {
      case 'auto-allow':
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: true,
        });
        onComplete(t('✓ Sandbox enabled with auto-allow for bash commands'));
        break;
      case 'regular':
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: false,
        });
        onComplete(t('✓ Sandbox enabled with regular bash permissions'));
        break;
      case 'disabled':
        await SandboxManager.setSandboxSettings({
          enabled: false,
          autoAllowBashIfSandboxed: false,
        });
        onComplete(t('○ Sandbox disabled'));
        break;
    }
  }

  useKeybindings(
    {
      'confirm:no': () => onComplete(undefined, { display: 'skip' }),
    },
    { context: 'Settings' },
  );

  const modeTab = (
    <Tab key="mode" title={t('Mode')}>
      <SandboxModeTab
        showSocketWarning={showSocketWarning}
        options={options}
        onSelect={handleSelect}
        onComplete={onComplete}
      />
    </Tab>
  );

  const overridesTab = (
    <Tab key="overrides" title={t('Overrides')}>
      <SandboxOverridesTab onComplete={onComplete} />
    </Tab>
  );

  const configTab = (
    <Tab key="config" title={t('Config')}>
      <SandboxConfigTab />
    </Tab>
  );

  const hasErrors = depCheck.errors.length > 0;

  // If required deps missing, only show Dependencies tab
  // If only optional deps missing, show all tabs
  const tabs = hasErrors
    ? [
        <Tab key="dependencies" title={t('Dependencies')}>
          <SandboxDependenciesTab depCheck={depCheck} />
        </Tab>,
      ]
    : [
        modeTab,
        ...(hasWarnings
          ? [
              <Tab key="dependencies" title={t('Dependencies')}>
                <SandboxDependenciesTab depCheck={depCheck} />
              </Tab>,
            ]
          : []),
        overridesTab,
        configTab,
      ];

  return (
    <Pane color="permission">
      <Tabs title={t('Sandbox:')} color="permission" defaultTab="Mode">
        {tabs}
      </Tabs>
    </Pane>
  );
}

function SandboxModeTab({
  showSocketWarning,
  options,
  onSelect,
  onComplete,
}: {
  showSocketWarning: boolean;
  options: Array<{ label: string; value: string }>;
  onSelect: (value: string) => void;
  onComplete: Props['onComplete'];
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  return (
    <Box flexDirection="column" paddingY={1}>
      {showSocketWarning && (
        <Box marginBottom={1}>
          <Text color="warning">{t('Cannot block unix domain sockets (see Dependencies tab)')}</Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <Text bold>{t('Configure Mode:')}</Text>
      </Box>
      <Select
        options={options}
        onChange={onSelect}
        onCancel={() => onComplete(undefined, { display: 'skip' })}
        onUpFromFirstItem={focusHeader}
        isDisabled={headerFocused}
      />
      <Box flexDirection="column" marginTop={1} gap={1}>
        <Text dimColor>
          <Text bold dimColor>
            {t('Auto-allow mode:')}
          </Text>{' '}
          {t(
            'Commands will try to run in the sandbox automatically, and attempts to run outside of the sandbox fallback to regular permissions. Explicit ask/deny rules are always respected.',
          )}
        </Text>
        <Text dimColor>
          {t('Learn more: ')}
          <Link url="https://code.claude.com/docs/en/sandboxing">code.claude.com/docs/en/sandboxing</Link>
        </Text>
      </Box>
    </Box>
  );
}
