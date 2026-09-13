import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Box, Pane, Text } from '@anthropic/ink';
import { AVAILABLE_LOCALES, currentLocale, t } from '../../i18n/index.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { Select } from '../../components/CustomSelect/index.js';

// Language names are shown in their own language (never translated).
const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
};

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

function LanguagePicker({ onDone }: Props): React.ReactNode {
  const active = currentLocale();
  const options = AVAILABLE_LOCALES.map(tag => ({
    label: LOCALE_LABELS[tag] ?? tag,
    value: tag,
  }));

  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
        <Text bold>{t('Select display language')}</Text>
        <Select
          options={options}
          visibleOptionCount={options.length}
          defaultValue={active}
          defaultFocusValue={active}
          onChange={(tag: string) => {
            const locale = AVAILABLE_LOCALES.find(l => l === tag) ?? active;
            const name = LOCALE_LABELS[locale] ?? locale;
            if (locale === active) {
              onDone(t('UI language already set to {{name}}', { name }), { display: 'system' });
              return;
            }
            // updateSettingsForSource resets the settings cache, so the
            // t() call below already renders in the newly selected locale.
            updateSettingsForSource('userSettings', { uiLocale: locale });
            onDone(t('UI language set to {{name}}', { name }), {
              display: 'system',
            });
          }}
          onCancel={() => {
            onDone(t('Language selection dismissed'), { display: 'system' });
          }}
        />
      </Box>
    </Pane>
  );
}

export const call: LocalJSXCommandCall = async onDone => {
  return <LanguagePicker onDone={onDone} />;
};
