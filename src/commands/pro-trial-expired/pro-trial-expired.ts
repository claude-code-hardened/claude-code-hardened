/**
 * W3 task #54 — /pro-trial-expired: what to expect when a Claude Pro trial
 * ends, and the three ways to keep working.
 *
 * Pure notice surface: no persistence, no network, no bridge execution
 * (the copy is personal to the signed-in claude.ai account, so the command
 * is scoped to claude-ai availability via the command def).
 */

import type { LocalCommandCall } from '../../types/command.js'
import { PRO_TRIAL_EXPIRED_USAGE, parseProTrialExpiredArgs } from './args.js'

export function formatProTrialExpiredCopy(): string {
  return [
    '## Your Claude Pro trial has ended',
    '',
    'What changed:',
    '',
    '  - Usage limits reset to the paid Pro envelope (a smaller weekly',
    '    budget than the trial, shared across your devices).',
    '  - Model access stays the same, but heavy sessions may be throttled',
    '    sooner.',
    '  - Work already in this session is unaffected; limits apply to new',
    '    requests.',
    '',
    'Ways to keep working:',
    '',
    '  1. Upgrade for more headroom: /upgrade',
    '  2. Switch auth to a Console API key (usage billed per token): /login',
    '  3. Conserve the paid envelope: /poor mode, smaller tasks, and',
    '     /context to see what is consuming the window.',
    '',
    'Plan usage and limits: https://claude.ai/settings/usage (or run /usage).',
  ].join('\n')
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseProTrialExpiredArgs(rawArgs)
  switch (args.action) {
    case 'show':
      return { type: 'text', value: formatProTrialExpiredCopy() }
    case 'help':
      return { type: 'text', value: PRO_TRIAL_EXPIRED_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', PRO_TRIAL_EXPIRED_USAGE].join('\n'),
      }
  }
}
