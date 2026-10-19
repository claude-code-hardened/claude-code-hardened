/**
 * W3 task #54 — /auto-mode-setup: record that agent auto mode has been set
 * up on this machine.
 *
 * Persistence follows the /cloud-plugins marker-file pattern: a JSON record
 * under the Claude config home so the choice survives restarts without
 * adding a settings core key. The auto-mode runtime itself (schedule,
 * trigger policies) lives elsewhere; this command owns the setup consent
 * surface only.
 *
 * Honesty note: the record is user-attested — enabling writes the marker,
 * it does not configure or verify any auto-mode runtime. The official
 * wizard/proposal/apply flags are parsed (see args.ts) but answered with
 * an explicit "not supported in this build" message; they never mutate
 * the marker.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { AUTO_MODE_SETUP_USAGE, parseAutoModeSetupArgs } from './args.js'

export interface AutoModeSetupRecord {
  enabled: boolean
  updatedAt: string
}

export function getAutoModeSetupPath(): string {
  return join(getClaudeConfigHomeDir(), 'auto-mode-setup.json')
}

export function loadAutoModeSetup(): AutoModeSetupRecord | null {
  const path = getAutoModeSetupPath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as AutoModeSetupRecord | null
    if (!parsed || typeof parsed.enabled !== 'boolean') return null
    return parsed
  } catch {
    return null
  }
}

function writeRecord(enabled: boolean): void {
  const record: AutoModeSetupRecord = {
    enabled,
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(getClaudeConfigHomeDir(), { recursive: true })
  writeFileSync(
    getAutoModeSetupPath(),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  )
}

function status(): string {
  const record = loadAutoModeSetup()
  return [
    '## Auto mode setup',
    '',
    `  Status:  ${record?.enabled ? 'set up' : 'not set up'}`,
    record ? `  Since:   ${record.updatedAt}` : undefined,
    `  Marker:  ${getAutoModeSetupPath()}`,
    undefined,
    record?.enabled
      ? 'Auto mode was configured with /auto-mode-setup enable. Change it any time with /auto-mode-setup disable.'
      : 'Run /auto-mode-setup enable once auto mode is configured (claude auto-mode) to record the setup.',
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseAutoModeSetupArgs(rawArgs)
  switch (args.action) {
    case 'status':
      return {
        type: 'text',
        value: status(),
      }
    case 'enable': {
      writeRecord(true)
      return {
        type: 'text',
        value: [
          '## Auto mode setup recorded',
          '',
          'The local marker now reports auto mode as set up (user-attested —',
          'this command records the marker; it does not configure the',
          'auto-mode runtime itself).',
          '',
          `Disable: /auto-mode-setup disable.  Marker: ${getAutoModeSetupPath()}`,
        ].join('\n'),
      }
    }
    case 'disable': {
      if (loadAutoModeSetup()?.enabled) {
        writeRecord(false)
      }
      return {
        type: 'text',
        value: [
          '## Auto mode setup cleared',
          '',
          'The auto-mode setup marker no longer reports as set up.',
          '',
          `Re-run: /auto-mode-setup enable.  Marker: ${getAutoModeSetupPath()}`,
        ].join('\n'),
      }
    }
    case 'help':
      return { type: 'text', value: AUTO_MODE_SETUP_USAGE }
    case 'unsupported':
      // Parsed a real official invocation, but the wizard/proposal/apply
      // runtime does not exist here. Report it plainly — never mutate the
      // marker to fake success.
      return {
        type: 'text',
        value: [
          '## Auto mode setup — not supported in this build',
          '',
          'The invocation was parsed, but this build only executes the plain',
          'enable/disable/status marker flow. Not supported here:',
          '',
          ...args.flags.map(flag => `  - ${flag}`),
          '',
          'What works: /auto-mode-setup enable | disable | status',
        ].join('\n'),
      }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', AUTO_MODE_SETUP_USAGE].join('\n'),
      }
  }
}
