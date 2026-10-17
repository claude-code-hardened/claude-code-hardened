import React from 'react';
import { Text } from '@anthropic/ink';
import { formatDuration } from '../../utils/format.js';
import { t } from '../../i18n/index.js';

type Props = {
  elapsedTimeSeconds?: number;
  timeoutMs?: number;
};

export function ShellTimeDisplay({ elapsedTimeSeconds, timeoutMs }: Props): React.ReactNode {
  if (elapsedTimeSeconds === undefined && !timeoutMs) {
    return null;
  }
  const timeout = timeoutMs ? formatDuration(timeoutMs, { hideTrailingZeros: true }) : undefined;
  if (elapsedTimeSeconds === undefined) {
    return <Text dimColor>{t('(timeout {{time}})', { time: timeout })}</Text>;
  }
  const elapsed = formatDuration(elapsedTimeSeconds * 1000);
  if (timeout) {
    return <Text dimColor>{t('({{elapsed}} · timeout {{time}})', { elapsed, time: timeout })}</Text>;
  }
  return <Text dimColor>{`(${elapsed})`}</Text>;
}
