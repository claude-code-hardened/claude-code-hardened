/**
 * W3 task #54 — /design-login argument parser. Pure module.
 */

export type DesignLoginArgs =
  | { action: 'status' }
  | { action: 'connect' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const DESIGN_LOGIN_USAGE = [
  'Usage: /design-login [connect | status]',
  '',
  '  (no args)  Show the local design-session marker status',
  '  connect    Store the local consent marker (no cloud session — design',
  '             sync is not enabled in this build)',
  '  status     Show the marker and its location',
].join('\n')

export function parseDesignLoginArgs(raw: string): DesignLoginArgs {
  const sub = raw.trim().toLowerCase()
  switch (sub) {
    case '':
    case 'status':
      return { action: 'status' }
    case 'connect':
      return { action: 'connect' }
    case 'help':
      return { action: 'help' }
    default:
      return { action: 'invalid', error: `Unknown subcommand: "${sub}"` }
  }
}
