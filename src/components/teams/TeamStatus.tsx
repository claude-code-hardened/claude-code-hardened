import * as React from 'react';
import { Text } from '@anthropic/ink';
import { useAppState } from '../../state/AppState.js';
import { t } from '../../i18n/index.js';

type Props = {
  teamsSelected: boolean;
  showHint: boolean;
};

/**
 * Footer status indicator showing teammate count
 * Similar to BackgroundTaskStatus but for teammates
 */
export function TeamStatus({ teamsSelected, showHint }: Props): React.ReactNode {
  const teamContext = useAppState(s => s.teamContext);

  // Derive teammate count from teamContext (no filesystem I/O needed)
  const totalTeammates = teamContext
    ? Object.values(teamContext.teammates).filter(t => t.name !== 'team-lead').length
    : 0;

  if (totalTeammates === 0) {
    return null;
  }

  const hint =
    showHint && teamsSelected ? (
      <>
        <Text dimColor>· </Text>
        <Text dimColor>{t('Enter to view')}</Text>
      </>
    ) : null;

  const statusText = t('{{n}} {{s}}', {
    n: totalTeammates,
    s: totalTeammates === 1 ? t('teammate') : t('teammates'),
  });

  return (
    <>
      <Text key={teamsSelected ? 'selected' : 'normal'} color="background" inverse={teamsSelected}>
        {statusText}
      </Text>
      {hint ? <Text> {hint}</Text> : null}
    </>
  );
}
