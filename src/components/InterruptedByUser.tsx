import * as React from 'react';
import { Text } from '@anthropic/ink';
import { t } from '../i18n/index.js';

export function InterruptedByUser(): React.ReactNode {
  return (
    <>
      <Text dimColor>{t('Interrupted')} </Text>
      {process.env.USER_TYPE === 'ant' ? (
        <Text dimColor>{t('· [ANT-ONLY] /issue to report a model issue')}</Text>
      ) : (
        <Text dimColor>{t('· What should Claude do instead?')}</Text>
      )}
    </>
  );
}
