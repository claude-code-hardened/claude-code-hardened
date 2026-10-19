/**
 * W3 task #54 — /cloud-plugins argument parser. Pure module.
 */

export type CloudPluginsArgs =
  | { action: 'toggle' }
  | { action: 'on' }
  | { action: 'off' }
  | { action: 'status' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const CLOUD_PLUGINS_USAGE = [
  'Usage: /cloud-plugins [on | off | status]',
  '',
  '  (no args)  Toggle whether cloud sessions use the plugins enabled on this machine',
  '  on/off     Set the choice explicitly',
  '  status     Show the current choice',
].join('\n')

export function parseCloudPluginsArgs(raw: string): CloudPluginsArgs {
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
