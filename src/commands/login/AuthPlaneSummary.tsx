/**
 * AuthPlaneSummary — pure presentational Ink component.
 *
 * Renders the three auth plane status table shown when the user runs /login
 * without arguments:
 *
 *   Anthropic auth status:
 *     ☑ Subscription (claude.ai)         pro plan
 *     ☐ Workspace API key                not set
 *          To enable /vault /agents-platform /memory-stores:
 *          1. Open https://console.anthropic.com/settings/keys
 *          ...
 *
 *   Third-party providers:
 *     ✓ Cerebras   (CEREBRAS_API_KEY set)
 *     ☐ Groq       (GROQ_API_KEY not set)
 *     ...
 *
 * Security: never renders raw API key values. All output uses masked previews.
 */
import * as React from 'react';
import { t } from '../../i18n/index.js';
import { Box, Text } from '@anthropic/ink';
import type { AuthStatus } from './getAuthStatus.js';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SubscriptionRow({ subscription }: { subscription: AuthStatus['subscription'] }): React.ReactNode {
  const icon = subscription.active ? '☑' : '☐';
  const planLabel = subscription.active && subscription.plan ? ` ${subscription.plan} ${t('plan')}` : '';
  const statusText = subscription.active ? `${t('logged in')}${planLabel}` : t('not logged in');

  return (
    <Box>
      <Text color={subscription.active ? 'success' : undefined}>
        {icon} {t('Subscription (claude.ai)')}
        {'  '}
      </Text>
      <Text dimColor={!subscription.active}>{statusText}</Text>
    </Box>
  );
}

function WorkspaceKeyRow({ workspaceKey }: { workspaceKey: AuthStatus['workspaceKey'] }): React.ReactNode {
  if (!workspaceKey.set) {
    return (
      <Box>
        <Text>{`☐ ${t('Workspace API key')}                `}</Text>
        <Text dimColor>{t('not set')}</Text>
      </Box>
    );
  }

  if (!workspaceKey.prefixValid) {
    return (
      <Box>
        <Text color="warning">{`⚠ ${t('Workspace API key')}                `}</Text>
        <Text>{workspaceKey.keyPreview}</Text>
        <Text color="warning">{`  ${t('(sk-ant-api03-* required)')}`}</Text>
      </Box>
    );
  }

  // Source label: distinguish env var from saved settings
  const sourceLabel =
    workspaceKey.source === 'settings'
      ? `  ${t('(saved to settings)')}`
      : workspaceKey.source === 'env'
        ? `  ${t('(from ANTHROPIC_API_KEY env)')}`
        : '';

  return (
    <Box>
      <Text color="success">{`☑ ${t('Workspace API key')}                `}</Text>
      <Text>{workspaceKey.keyPreview}</Text>
      {sourceLabel ? <Text dimColor>{sourceLabel}</Text> : null}
    </Box>
  );
}

function WorkspaceKeyInstructions({
  subscription,
  workspaceKey,
}: {
  subscription: AuthStatus['subscription'];
  workspaceKey: AuthStatus['workspaceKey'];
}): React.ReactNode {
  // Show setup guide when workspace key is missing and subscription is active (user is logged in)
  if (!workspaceKey.set && subscription.active) {
    return (
      <Box flexDirection="column" marginLeft={5} marginTop={0}>
        <Text dimColor>{t('To enable /vault /agents-platform /memory-stores:')}</Text>
        <Text dimColor>{t('Press W to set now (saves to settings.json, no restart needed)')}</Text>
        <Text dimColor>{t('  — or —')}</Text>
        <Text dimColor>{t('1. Open https://console.anthropic.com/settings/keys')}</Text>
        <Text dimColor>{t('2. Create a key (sk-ant-api03-*)')}</Text>
        <Text dimColor>{t('3. Set ANTHROPIC_API_KEY=<key> and restart')}</Text>
      </Box>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------
//
// Third-party providers were previously listed here with their own status rows
// (Cerebras / Groq / Qwen / DeepSeek). Removed 2026-05-06 because the fork's
// existing `<Login>` "Anthropic Compatible Setup" form already configures the
// same Base URL + API key, and showing two parallel UIs for the same goal
// confused users. Subscription + Workspace key remain — those are distinct
// Anthropic-side auth planes the fork form doesn't surface.

export interface AuthPlaneSummaryProps {
  status: AuthStatus;
}

export function AuthPlaneSummary({ status }: AuthPlaneSummaryProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Section: Anthropic auth status */}
      <Box marginBottom={0}>
        <Text bold>{t('Anthropic auth status:')}</Text>
      </Box>

      <Box marginLeft={2} flexDirection="column">
        <SubscriptionRow subscription={status.subscription} />
        <WorkspaceKeyRow workspaceKey={status.workspaceKey} />
        <WorkspaceKeyInstructions subscription={status.subscription} workspaceKey={status.workspaceKey} />
      </Box>
    </Box>
  );
}
