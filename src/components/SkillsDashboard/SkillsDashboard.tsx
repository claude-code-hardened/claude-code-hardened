import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { logForDebugging } from '../../utils/debug.js';
import { formatTokens } from '../../utils/format.js';
import { useSkillsDashboard, type UseSkillsDashboardOptions } from './useSkillsDashboard.js';

/**
 * Skills Dashboard — claude.ai skills health panel (upstream anchor 0025
 * module-003 :915). Renders the local skill registry with cloud health
 * merged when the SKILLS_SYNC gate is open (default OFF, in which case the
 * health column shows a dash and no network call is made).
 *
 * Data assembly lives in useSkillsDashboard; this component is presentation
 * only and forwards caller options (getSkills / fetchImpl overrides) through.
 */

export type SkillsDashboardProps = UseSkillsDashboardOptions;

export function SkillsDashboard(props: SkillsDashboardProps): React.ReactNode {
  const { state, rows, error, cloudHealthEnabled, apiBase } = useSkillsDashboard(props);

  if (state === 'loading') {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading skills…</Text>
      </Box>
    );
  }

  if (state === 'error') {
    logForDebugging(`[skills-dashboard] render error state: ${error}`);
    return (
      <Box flexDirection="column">
        <Text color="error">Failed to load skills: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Skills ({rows.length})</Text>
      {rows.length === 0 ? (
        <Text dimColor>No skills loaded.</Text>
      ) : (
        rows.map(row => (
          <Box key={row.identifier} gap={2}>
            <Box width={34} flexShrink={0}>
              <Text>{row.displayName}</Text>
            </Box>
            <Box width={22} flexShrink={0}>
              <Text dimColor>{row.loadedFrom}</Text>
            </Box>
            <Box width={12} flexShrink={0}>
              <Text dimColor>{formatTokens(row.contextTokens)}</Text>
            </Box>
            <Text dimColor>{row.health ?? (cloudHealthEnabled ? '—' : 'local')}</Text>
          </Box>
        ))
      )}
      <Text dimColor>
        {cloudHealthEnabled ? `Cloud health: ${apiBase}` : 'Cloud health off (SKILLS_SYNC disabled)'}
      </Text>
    </Box>
  );
}
