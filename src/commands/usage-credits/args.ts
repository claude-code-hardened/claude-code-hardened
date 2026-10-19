/**
 * W3 task #54 — /usage-credits argument parser. Pure module.
 */

export const USAGE_LINK = 'https://claude.ai/settings/usage'

export type UsageCreditsArgs =
  | { action: 'show' }
  | { action: 'request' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const USAGE_CREDITS_USAGE = [
  'Usage: /usage-credits [request]',
  '',
  '  (no args)  Show usage summary and credits guidance',
  '  request    Print a copy-paste request you can send to your admin',
].join('\n')

export function parseUsageCreditsArgs(raw: string): UsageCreditsArgs {
  const sub = raw.trim().toLowerCase()
  if (sub === '') return { action: 'show' }
  if (sub === 'request') return { action: 'request' }
  if (sub === 'help') return { action: 'help' }
  return { action: 'invalid', error: `Unknown subcommand: "${sub}"` }
}
