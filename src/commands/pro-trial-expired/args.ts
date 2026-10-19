/**
 * W3 task #54 — /pro-trial-expired argument parser. Pure module.
 */

export type ProTrialExpiredArgs =
  | { action: 'show' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const PRO_TRIAL_EXPIRED_USAGE = [
  'Usage: /pro-trial-expired',
  '',
  '  Explains what changes when your Claude Pro trial ends and how to keep',
  '  working (upgrade, switch auth, or downgrade usage). Takes no arguments.',
].join('\n')

export function parseProTrialExpiredArgs(raw: string): ProTrialExpiredArgs {
  const sub = raw.trim().toLowerCase()
  switch (sub) {
    case '':
    case 'show':
      return { action: 'show' }
    case 'help':
      return { action: 'help' }
    default:
      return { action: 'invalid', error: `Unknown argument: "${sub}"` }
  }
}
