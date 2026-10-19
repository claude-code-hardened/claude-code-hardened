/**
 * W3 task #54 — /design-consent: record whether the user consents to design
 * review sessions reading workspace files.
 *
 * The consent decision is persisted locally (<config home>/design-consent.json)
 * so design surfaces can gate on it without a settings core key.
 *
 * Honesty note: no design-review surface reads this marker yet in this build
 * (the design session transport does not exist here), so granting or
 * declining changes the local record only — it does not unlock or block any
 * live behaviour. The output says exactly that.
 */

import { join } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  readJsonFileStrict,
  rejectCorruptJsonFile,
  writeJsonFileAtomic,
} from '../../utils/safeJsonFile.js'
import { DESIGN_CONSENT_USAGE, parseDesignConsentArgs } from './args.js'

export interface DesignConsentRecord {
  consent: 'granted' | 'declined'
  updatedAt: string
}

export function getDesignConsentPath(): string {
  return join(getClaudeConfigHomeDir(), 'design-consent.json')
}

/**
 * Load the consent record. A corrupt file is quarantined to a .corrupt-<ts>
 * backup and StoreCorruptError is raised — a lost consent decision is
 * reported, never silently rewritten as "not recorded".
 */
export function loadDesignConsent(): DesignConsentRecord | null {
  const path = getDesignConsentPath()
  const parsed = readJsonFileStrict(path)
  if (parsed === null) return null
  const record = parsed as Partial<DesignConsentRecord> | null
  if (
    !record ||
    (record.consent !== 'granted' && record.consent !== 'declined') ||
    typeof record.updatedAt !== 'string'
  ) {
    rejectCorruptJsonFile(path, 'not a design consent record')
  }
  return record as DesignConsentRecord
}

function writeRecord(consent: 'granted' | 'declined'): void {
  const record: DesignConsentRecord = {
    consent,
    updatedAt: new Date().toISOString(),
  }
  writeJsonFileAtomic(getDesignConsentPath(), record)
}

function status(): string {
  const record = loadDesignConsent()
  const decision = record?.consent ?? 'not recorded'
  return [
    '## Design session consent',
    '',
    `  Decision: ${decision}`,
    record ? `  Since:    ${record.updatedAt}` : undefined,
    `  Record:   ${getDesignConsentPath()}`,
    undefined,
    'This build has no design-review surface yet: the marker is recorded',
    'locally only (no cloud session — design sync is not enabled in this',
    'build).',
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseDesignConsentArgs(rawArgs)
  switch (args.action) {
    case 'status':
      return { type: 'text', value: status() }
    case 'grant': {
      writeRecord('granted')
      return {
        type: 'text',
        value: [
          '## Consent recorded: granted',
          '',
          'Stored local consent marker (no cloud session — design sync is',
          'not enabled in this build). No design surface reads this marker',
          'yet; nothing changed beyond the local record.',
          '',
          `Change it: /design-consent decline.  Record: ${getDesignConsentPath()}`,
        ].join('\n'),
      }
    }
    case 'decline': {
      writeRecord('declined')
      return {
        type: 'text',
        value: [
          '## Consent recorded: declined',
          '',
          'Stored local consent marker (no cloud session — design sync is',
          'not enabled in this build). No design surface reads this marker',
          'yet; nothing changed beyond the local record.',
          '',
          `Change it: /design-consent grant.  Record: ${getDesignConsentPath()}`,
        ].join('\n'),
      }
    }
    case 'help':
      return { type: 'text', value: DESIGN_CONSENT_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', DESIGN_CONSENT_USAGE].join('\n'),
      }
  }
}
