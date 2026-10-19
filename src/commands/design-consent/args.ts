/**
 * W3 task #54 — /design-consent argument parser. Pure module.
 */

export type DesignConsentArgs =
  | { action: 'status' }
  | { action: 'grant' }
  | { action: 'decline' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const DESIGN_CONSENT_USAGE = [
  'Usage: /design-consent [grant | decline | status]',
  '',
  '  (no args)  Show the current design-session consent',
  '  grant      Consent to design review sessions reading workspace files',
  '  decline    Record a decline; design sessions stay off',
  '  status     Show the recorded consent decision',
].join('\n')

export function parseDesignConsentArgs(raw: string): DesignConsentArgs {
  const sub = raw.trim().toLowerCase()
  switch (sub) {
    case '':
    case 'status':
      return { action: 'status' }
    case 'grant':
      return { action: 'grant' }
    case 'decline':
      return { action: 'decline' }
    case 'help':
      return { action: 'help' }
    default:
      return { action: 'invalid', error: `Unknown subcommand: "${sub}"` }
  }
}
