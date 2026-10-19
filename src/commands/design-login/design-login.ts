/**
 * W3 task #54 — /design-login: store a local design-session marker.
 *
 * Honesty note: there is no design-tool OAuth/device flow and no cloud
 * session in this build. Connect never authenticates anything — it records a
 * local placeholder marker (<config home>/design-session.json) that
 * /design-revoke clears. The output says exactly that.
 */

import type { LocalCommandCall } from '../../types/command.js'
import { DESIGN_LOGIN_USAGE, parseDesignLoginArgs } from './args.js'
import {
  getDesignSessionPath,
  loadDesignSession,
  writeDesignSession,
} from './designStore.js'

export function formatDesignLoginStatus(): string {
  const record = loadDesignSession()
  const state =
    record?.status === 'connected'
      ? 'marker recorded (placeholder — no cloud session)'
      : 'no marker recorded'
  return [
    '## Design session',
    '',
    `  Status:   ${state}`,
    record ? `  Since:    ${record.updatedAt}` : undefined,
    `  Record:   ${getDesignSessionPath()}`,
    undefined,
    'This build has no real design-login flow: /design-login connect only',
    'stores a local consent marker (no cloud session — design sync is not',
    'enabled in this build).',
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseDesignLoginArgs(rawArgs)
  switch (args.action) {
    case 'status':
      return { type: 'text', value: formatDesignLoginStatus() }
    case 'connect': {
      writeDesignSession('connected')
      return {
        type: 'text',
        value: [
          '## Design session marker stored',
          '',
          'Stored local consent marker (no cloud session — design sync is',
          'not enabled in this build). No OAuth or device flow ran, and no',
          'authentication was performed.',
          '',
          'Disconnect: /design-revoke.',
          `Record: ${getDesignSessionPath()}`,
        ].join('\n'),
      }
    }
    case 'help':
      return { type: 'text', value: DESIGN_LOGIN_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', DESIGN_LOGIN_USAGE].join('\n'),
      }
  }
}
