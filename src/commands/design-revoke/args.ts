/**
 * W3 task #54 — /design-revoke argument parser. Pure module.
 */

export type DesignRevokeArgs =
  | { action: 'revoke' }
  | { action: 'status' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const DESIGN_REVOKE_USAGE = [
  'Usage: /design-revoke [status]',
  '',
  '  (no args)  Revoke the design session connection recorded by /design-login',
  '  status     Show the connection record without revoking',
].join('\n')

export function parseDesignRevokeArgs(raw: string): DesignRevokeArgs {
  const sub = raw.trim().toLowerCase()
  switch (sub) {
    case '':
      return { action: 'revoke' }
    case 'status':
      return { action: 'status' }
    case 'help':
      return { action: 'help' }
    default:
      return { action: 'invalid', error: `Unknown subcommand: "${sub}"` }
  }
}
