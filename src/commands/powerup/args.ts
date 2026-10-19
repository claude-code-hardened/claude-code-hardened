/**
 * W3 task #54 — /powerup argument parser. Pure module.
 *
 * The command is a static course checklist: bare invocation (or "show")
 * prints it. There is nothing to claim, list from a balance, or spend.
 */

export type PowerupArgs =
  | { action: 'show' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const POWERUP_USAGE = [
  'Usage: /powerup [help]',
  '',
  '  (no args)  Show the step-by-step course checklist',
  '  help       Show this help',
  '',
  'Takes no other arguments — there is no balance to claim or spend.',
].join('\n')

export function parsePowerupArgs(raw: string): PowerupArgs {
  const sub = raw.trim().toLowerCase()
  switch (sub) {
    case '':
      return { action: 'show' }
    case 'show':
      return { action: 'show' }
    case 'help':
      return { action: 'help' }
    default:
      return { action: 'invalid', error: `Unknown argument: "${sub}"` }
  }
}
