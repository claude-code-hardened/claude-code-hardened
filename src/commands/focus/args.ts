/**
 * W3 task #54 — /focus argument parser. Pure module.
 */

export type FocusArgs =
  | { action: 'toggle' }
  | { action: 'on' }
  | { action: 'off' }
  | { action: 'status' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const FOCUS_USAGE = [
  'Usage: /focus [on | off | status]',
  '',
  '  (no args)  Toggle the focus view preference',
  '  on/off     Set the focus view preference explicitly',
  '  status     Show the stored preference and the renderer note',
  '',
  'Focus view shows only your prompt and a summary of each response.',
  'Note: the focus view renderer is not wired in this build — the',
  'command persists the preference and says so; it does not claim the',
  'view is active.',
].join('\n')

export function parseFocusArgs(raw: string): FocusArgs {
  const sub = raw.trim().toLowerCase()
  switch (sub) {
    case '':
      return { action: 'toggle' }
    case 'on':
      return { action: 'on' }
    case 'off':
      return { action: 'off' }
    case 'status':
      return { action: 'status' }
    case 'help':
      return { action: 'help' }
    default:
      return { action: 'invalid', error: `Unknown subcommand: "${sub}"` }
  }
}
