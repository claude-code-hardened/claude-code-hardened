import figures from 'figures';
import { homedir } from 'os';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';
import type { Step } from '../../projectOnboardingState.js';
import { formatCreditAmount, getCachedReferrerReward } from '../../services/api/referral.js';
import type { LogOption } from '../../types/logs.js';
import { getCwd } from '../../utils/cwd.js';
import { formatRelativeTimeAgo } from '../../utils/format.js';
import type { FeedConfig, FeedLine } from './Feed.js';

export function createRecentActivityFeed(activities: LogOption[]): FeedConfig {
  const lines: FeedLine[] = activities.map(log => {
    const time = formatRelativeTimeAgo(log.modified);
    const description = log.summary && log.summary !== 'No prompt' ? log.summary : log.firstPrompt;

    return {
      text: description || '',
      timestamp: time,
    };
  });

  return {
    title: t('Recent activity'),
    lines,
    footer: lines.length > 0 ? t('/resume for more') : undefined,
    emptyMessage: t('No recent activity'),
  };
}

export function createWhatsNewFeed(releaseNotes: string[]): FeedConfig {
  const lines: FeedLine[] = releaseNotes.map(note => {
    if (process.env.USER_TYPE === 'ant') {
      const match = note.match(/^(\d+\s+\w+\s+ago)\s+(.+)$/);
      if (match) {
        return {
          timestamp: match[1],
          text: match[2] || '',
        };
      }
    }
    return {
      text: note,
    };
  });

  const emptyMessage =
    process.env.USER_TYPE === 'ant'
      ? t('Unable to fetch latest claude-cli-internal commits')
      : t('Check the Claude Code changelog for updates');

  return {
    title: process.env.USER_TYPE === 'ant' ? t("What's new [ANT-ONLY: Latest CC commits]") : t("What's new"),
    lines,
    footer: lines.length > 0 ? t('/release-notes for more') : undefined,
    emptyMessage,
  };
}

export function createProjectOnboardingFeed(steps: Step[]): FeedConfig {
  const enabledSteps = steps
    .filter(({ isEnabled }) => isEnabled)
    .sort((a, b) => Number(a.isComplete) - Number(b.isComplete));

  const lines: FeedLine[] = enabledSteps.map(({ text, isComplete }) => {
    const checkmark = isComplete ? `${figures.tick} ` : '';
    return {
      text: `${checkmark}${text}`,
    };
  });

  const warningText =
    getCwd() === homedir()
      ? t('Note: You have launched claude in your home directory. For the best experience, launch it in a project directory instead.')
      : undefined;

  if (warningText) {
    lines.push({
      text: warningText,
    });
  }

  return {
    title: t('Tips for getting started'),
    lines,
  };
}

export function createGuestPassesFeed(): FeedConfig {
  const reward = getCachedReferrerReward();
  const subtitle = reward
    ? t('Share Claude Code and earn {{amount}} of extra usage', { amount: formatCreditAmount(reward) })
    : t('Share Claude Code with friends');
  return {
    title: t('3 guest passes'),
    lines: [],
    customContent: {
      content: (
        <>
          <Box marginY={1}>
            <Text color="claude">[✻] [✻] [✻]</Text>
          </Box>
          <Text dimColor>{subtitle}</Text>
        </>
      ),
      width: 48,
    },
    footer: '/passes',
  };
}
