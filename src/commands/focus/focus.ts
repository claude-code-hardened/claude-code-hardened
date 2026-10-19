/**
 * W3 task #54 — /focus: persist the focus-view preference ([on|off]).
 *
 * Official semantics: the focus view shows only the user's prompt and a
 * summary of each response instead of the full conversation transcript.
 *
 * Honesty note: this build does not wire a focus view renderer, so the
 * persisted preference cannot change what is drawn on screen yet. Every
 * message below says exactly that instead of claiming an active focus
 * view — the stored record is a preference, not a live behavior.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { FOCUS_USAGE, parseFocusArgs } from './args.js'

export interface FocusModeRecord {
  enabled: boolean
  updatedAt: string
}

/** Renderer honesty note shared by the enable/disable/status surfaces. */
export const FOCUS_RENDERER_NOTE =
  'The focus view renderer is not wired in this build — the conversation keeps rendering in the full view. The preference is stored so a future build can honor it.'

export function getFocusModePath(): string {
  return join(getClaudeConfigHomeDir(), 'focus-mode.json')
}

export function isFocusModeEnabled(): boolean {
  const path = getFocusModePath()
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as FocusModeRecord | null
    return parsed?.enabled === true
  } catch {
    return false
  }
}

function writeRecord(enabled: boolean): void {
  const record: FocusModeRecord = {
    enabled,
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(getClaudeConfigHomeDir(), { recursive: true })
  writeFileSync(
    getFocusModePath(),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  )
}

/** Pure copy builder for the on/off confirmation (persisted preference only). */
export function buildFocusSetMessage(enabled: boolean, was: boolean): string {
  return [
    `## Focus view preference ${enabled ? 'on' : 'off'}`,
    '',
    enabled
      ? 'Saved: in focus view only your prompt and a summary of each response would be shown.'
      : 'Saved: the full conversation view is used.',
    was === enabled ? '(Preference was already set this way.)' : undefined,
    '',
    `Note: ${FOCUS_RENDERER_NOTE}`,
    '',
    `Change it: /focus ${enabled ? 'off' : 'on'}  Record: ${getFocusModePath()}`,
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

/** Pure copy builder for the status surface. */
export function buildFocusStatusMessage(enabled: boolean): string {
  return [
    '## Focus view',
    '',
    `  State:  ${enabled ? 'on' : 'off'} (stored preference)`,
    `  Record: ${getFocusModePath()}`,
    '',
    `  Note: ${FOCUS_RENDERER_NOTE}`,
    '',
    `Change it: /focus ${enabled ? 'off' : 'on'}`,
  ].join('\n')
}

function setFocus(enabled: boolean): string {
  const was = isFocusModeEnabled()
  writeRecord(enabled)
  return buildFocusSetMessage(enabled, was)
}

function status(): string {
  return buildFocusStatusMessage(isFocusModeEnabled())
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseFocusArgs(rawArgs)
  switch (args.action) {
    case 'toggle':
      return { type: 'text', value: setFocus(!isFocusModeEnabled()) }
    case 'on':
      return { type: 'text', value: setFocus(true) }
    case 'off':
      return { type: 'text', value: setFocus(false) }
    case 'status':
      return { type: 'text', value: status() }
    case 'help':
      return { type: 'text', value: FOCUS_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', FOCUS_USAGE].join('\n'),
      }
  }
}
