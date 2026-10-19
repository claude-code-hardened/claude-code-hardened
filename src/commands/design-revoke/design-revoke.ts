/**
 * W3 task #54 — /design-revoke: clear the local design-session marker that
 * /design-login stored. Shares the store module with /design-login so both
 * commands agree on the <config home>/design-session.json persistence point.
 *
 * Honesty note: there is no live design session in this build — revoking
 * flips the local marker only.
 */

import type { LocalCommandCall } from '../../types/command.js'
import { DESIGN_REVOKE_USAGE, parseDesignRevokeArgs } from './args.js'
import {
  getDesignSessionPath,
  loadDesignSession,
  writeDesignSession,
} from '../design-login/designStore.js'

export const call: LocalCommandCall = async rawArgs => {
  const args = parseDesignRevokeArgs(rawArgs)
  switch (args.action) {
    case 'revoke': {
      const wasConnected = loadDesignSession()?.status === 'connected'
      writeDesignSession('revoked')
      return {
        type: 'text',
        value: [
          wasConnected
            ? '## Design session marker revoked'
            : '## Design session not connected',
          '',
          wasConnected
            ? 'The locally stored consent marker now reports as revoked. No live session existed — nothing beyond the local marker changed.'
            : 'No connected marker was recorded; the record now reports as revoked.',
          '',
          `Re-login: /design-login connect.  Record: ${getDesignSessionPath()}`,
        ].join('\n'),
      }
    }
    case 'status': {
      const record = loadDesignSession()
      return {
        type: 'text',
        value: [
          '## Design session',
          '',
          `  Status: ${
            record?.status === 'connected'
              ? 'marker recorded (placeholder — no cloud session)'
              : 'no marker recorded'
          }`,
          record ? `  Since:  ${record.updatedAt}` : undefined,
          `  Record: ${getDesignSessionPath()}`,
        ]
          .filter(line => line !== undefined)
          .join('\n'),
      }
    }
    case 'help':
      return { type: 'text', value: DESIGN_REVOKE_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', DESIGN_REVOKE_USAGE].join('\n'),
      }
  }
}
