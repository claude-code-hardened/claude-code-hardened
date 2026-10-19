/**
 * W3 task #54 — session command alias expansion: runtime hook point.
 *
 * `applyAliasesToInputText` is wired into the real input pipeline:
 * `processUserInputBase` (src/utils/processUserInput/processUserInput.ts)
 * applies it to slash input immediately before `processSlashCommand`, so
 * `/<alias> ...` forwards to the target command ahead of slash dispatch.
 *
 * Storage: `<getClaudeConfigHomeDir()>/aliases.json` — a flat map of
 * alias name -> { target, created }. Targets are command lines WITHOUT the
 * leading slash, e.g. alias "ci" -> "prompt:review the CI config".
 */

import { join } from 'path'
import {
  readJsonFileStrict,
  rejectCorruptJsonFile,
  writeJsonFileAtomic,
} from '../utils/safeJsonFile.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

export interface AliasEntry {
  target: string
  created: string
}

export type AliasMap = Record<string, AliasEntry>

export function getAliasStorePath(): string {
  return join(getClaudeConfigHomeDir(), 'aliases.json')
}

function isAliasMap(value: unknown): value is AliasMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as AliasEntry).target !== 'string'
    ) {
      return false
    }
  }
  return true
}

/**
 * Load the alias map. A corrupt file is quarantined to a .corrupt-<ts>
 * backup and StoreCorruptError is raised — the map is never silently
 * treated as empty and overwritten.
 */
export function loadAliasMap(): AliasMap {
  const path = getAliasStorePath()
  const parsed = readJsonFileStrict(path)
  if (parsed === null) return {}
  if (!isAliasMap(parsed)) {
    rejectCorruptJsonFile(path, 'not an alias map')
  }
  return parsed
}

export function saveAliasMap(map: AliasMap): void {
  writeJsonFileAtomic(getAliasStorePath(), map)
}

export function defineAlias(name: string, target: string): void {
  const map = loadAliasMap()
  map[name] = { target, created: new Date().toISOString() }
  saveAliasMap(map)
}

export function removeAlias(name: string): boolean {
  const map = loadAliasMap()
  if (!(name in map)) return false
  delete map[name]
  saveAliasMap(map)
  return true
}

/**
 * Expand the leading alias token of a user input line.
 *
 * Hook point: apply aliases to input before slash dispatch, INCLUDING builtin
 * command names (explicit user aliases win over builtins).
 */
export function applyAliasesToInputText(
  input: string,
  map: AliasMap = loadAliasMap(),
): string {
  return expandMessage(input, map)
}

/** Pure expansion: rewrite `/x rest` -> `/<target> rest` when `x` is an alias. */
export function expandMessage(input: string, map: AliasMap): string {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return input
  const spaceIdx = trimmed.search(/\s/)
  const head = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
  const tail = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx)
  const entry = map[head]
  if (!entry) return input
  return `/${entry.target}${tail}`
}
