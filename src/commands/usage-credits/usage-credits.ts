/**
 * W3 task #54 — /usage-credits: configure usage credits or request them from
 * your admin when you hit a limit.
 *
 * Local surface: renders a light usage summary (session cost + token totals
 * from bootstrap state) plus the admin-request guidance copy. The live
 * credits/config web flow is feature work (rate-limits track) — the command
 * links to it instead of calling it.
 */

import {
  getTotalCostUSD,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { t } from '../../i18n/index.js'
import {
  USAGE_CREDITS_USAGE,
  USAGE_LINK,
  parseUsageCreditsArgs,
} from './args.js'

export function formatUsageSummary(): string {
  const input = getTotalInputTokens()
  const output = getTotalOutputTokens()
  const cost = getTotalCostUSD()
  return [
    t('## Usage summary'),
    '',
    // `$` rides inside the interpolated value: a literal `$` before the
    // `{{…}}` placeholder would read as a JS template `${` and trip
    // biome's noTemplateCurlyInString warning.
    t('  Session cost:   {{cost}}', { cost: `$${cost.toFixed(4)}` }),
    t('  Input tokens:   {{input}}', { input: input.toLocaleString() }),
    t('  Output tokens:  {{output}}', { output: output.toLocaleString() }),
    '',
    t('  Plan usage and limits: {{link}} (or run /usage)', {
      link: USAGE_LINK,
    }),
  ].join('\n')
}

export function formatAdminRequestCopy(): string {
  return [
    t('## Request usage credits from your admin'),
    '',
    t('Copy the text below and send it to your workspace admin:'),
    '',
    '---',
    t('Subject: Claude Code usage credits request'),
    '',
    t('Hi,'),
    '',
    t(
      "I've hit my Claude Code plan usage limit while working. Could you\nallocate usage credits to my account so I can keep working?",
    ),
    '',
    t('My usage is visible at {{link}}.', { link: USAGE_LINK }),
    '---',
    '',
    t(
      'If you self-manage your plan, see /upgrade for higher limits and\n/usage-credits (this command) any time you hit a limit. {{link}} shows\nyour current plan usage and credits.',
      { link: USAGE_LINK },
    ),
  ].join('\n')
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseUsageCreditsArgs(rawArgs)
  switch (args.action) {
    case 'show':
      return {
        type: 'text',
        value: [
          formatUsageSummary(),
          '',
          t(
            'When you hit a limit: run /usage-credits request for an admin\nrequest template, or /upgrade for higher limits.',
          ),
        ].join('\n'),
      }
    case 'request':
      return { type: 'text', value: formatAdminRequestCopy() }
    case 'help':
      return { type: 'text', value: USAGE_CREDITS_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', USAGE_CREDITS_USAGE].join('\n'),
      }
  }
}
