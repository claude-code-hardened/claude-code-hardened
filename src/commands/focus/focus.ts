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
 *
 * Persistence goes through src/utils/safeJsonFile.ts: atomic tmp+rename
 * writes, strict reads (a corrupt store is quarantined to a .corrupt-* backup
 * and logged, then surfaces as "off" — an empty table — instead of throwing
 * the /focus command into an error), and a same-directory advisory
 * `<file>.lock` around the read-modify-write so two concurrent /focus
 * invocations cannot lose each other's update.
 */

import { join } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  readJsonFileStrict,
  StoreCorruptError,
  withStoreLock,
  writeJsonFileAtomic,
} from '../../utils/safeJsonFile.js'
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
  let parsed: unknown | null
  try {
    parsed = readJsonFileStrict(getFocusModePath())
  } catch (e) {
    if (e instanceof StoreCorruptError) {
      // Already quarantined + logged inside readJsonFileStrict. The store
      // surfaces as an empty table (the preference reads as "off") — the
      // raw bytes stay recoverable at e.backupPath.
      return false
    }
    throw e
  }
  return (parsed as FocusModeRecord | null)?.enabled === true
}

function writeRecord(enabled: boolean): void {
  const record: FocusModeRecord = {
    enabled,
    updatedAt: new Date().toISOString(),
  }
  // Atomic write (tmp + rename); concurrency is serialized by the caller's
  // withStoreLock below — never nest withStoreLock (it is not reentrant).
  writeJsonFileAtomic(getFocusModePath(), record)
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

/** Locked read-modify-write: set the preference and report what it was. */
function setFocus(enabled: boolean): string {
  return withStoreLock(getFocusModePath(), () => {
    const was = isFocusModeEnabled()
    writeRecord(enabled)
    return buildFocusSetMessage(enabled, was)
  })
}

/**
 * Locked toggle: the new value is decided INSIDE the lock so two concurrent
 * toggles cannot both observe the same previous state and write the same
 * value (a lost update).
 */
function setFocusToggle(): string {
  return withStoreLock(getFocusModePath(), () => {
    const was = isFocusModeEnabled()
    const enabled = !was
    writeRecord(enabled)
    return buildFocusSetMessage(enabled, was)
  })
}

function status(): string {
  return buildFocusStatusMessage(isFocusModeEnabled())
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseFocusArgs(rawArgs)
  switch (args.action) {
    case 'toggle':
      return { type: 'text', value: setFocusToggle() }
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
