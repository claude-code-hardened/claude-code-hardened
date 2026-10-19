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
    '## Usage summary',
    '',
    `  Session cost:   $${cost.toFixed(4)}`,
    `  Input tokens:   ${input.toLocaleString()}`,
    `  Output tokens:  ${output.toLocaleString()}`,
    '',
    `  Plan usage and limits: ${USAGE_LINK} (or run /usage)`,
  ].join('\n')
}

export function formatAdminRequestCopy(): string {
  return [
    '## Request usage credits from your admin',
    '',
    'Copy the text below and send it to your workspace admin:',
    '',
    '---',
    'Subject: Claude Code usage credits request',
    '',
    'Hi,',
    '',
    "I've hit my Claude Code plan usage limit while working. Could you",
    'allocate usage credits to my account so I can keep working?',
    '',
    `My usage is visible at ${USAGE_LINK}.`,
    '---',
    '',
    'If you self-manage your plan, see /upgrade for higher limits and',
    `/usage-credits (this command) any time you hit a limit. ${USAGE_LINK} shows`,
    'your current plan usage and credits.',
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
          'When you hit a limit: run /usage-credits request for an admin',
          'request template, or /upgrade for higher limits.',
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
