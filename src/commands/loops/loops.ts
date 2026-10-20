/**
 * W3 task #54 — /loops: list, create, and delete loops.
 *
 * Loop definitions are persisted locally to
 * `<getClaudeConfigHomeDir()>/loops.json` so they survive restarts. A loop is
 * a lightweight local record: { id, schedule, intervalMs, prompt, created }.
 *
 * Honesty note: the scheduler that would evaluate these records is NOT wired
 * in this build (upstream ships the command disabled the same way), so
 * create/list/delete are recording only. The command def sets
 * `isEnabled: () => false` to match the official disabled state, so the
 * command stays out of the menu but the code and records remain.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import {
  readJsonFileStrict,
  rejectCorruptJsonFile,
  writeJsonFileAtomic,
} from '../../utils/safeJsonFile.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { t } from '../../i18n/index.js'
import { LOOPS_USAGE, parseLoopsArgs } from './args.js'

export interface LoopDefinition {
  id: string
  schedule: string
  /** Parsed interval in ms — recorded for a future scheduler, not evaluated here. */
  intervalMs?: number
  prompt: string
  created: string
}

interface LoopsFile {
  loops: LoopDefinition[]
}

export function getLoopsPath(): string {
  return join(getClaudeConfigHomeDir(), 'loops.json')
}

export function loadLoops(): LoopDefinition[] {
  const path = getLoopsPath()
  const parsed = readJsonFileStrict(path)
  if (parsed === null) return []
  if (Array.isArray(parsed)) return parsed as LoopDefinition[]
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as LoopsFile).loops)
  ) {
    return (parsed as LoopsFile).loops
  }
  rejectCorruptJsonFile(path, 'neither a loop list nor {loops: [...]}')
}

export function saveLoops(loops: LoopDefinition[]): void {
  const payload: LoopsFile = { loops }
  writeJsonFileAtomic(getLoopsPath(), payload)
}

function formatLoop(loop: LoopDefinition): string {
  return `  ${loop.id}  ${loop.schedule}  ${loop.prompt}`
}

function listLoops(): LocalCommandResult {
  const loops = loadLoops()
  if (loops.length === 0) {
    return {
      type: 'text',
      value: [
        t('No loops defined.'),
        '',
        t('Create one: /loops create @every 30m check the CI status'),
      ].join('\n'),
    }
  }
  return {
    type: 'text',
    value: [
      t('Loops:'),
      ...loops.map(formatLoop),
      '',
      t(
        'Recording only — no scheduler is wired in this build; saved loops\ndo not fire on their own.',
      ),
    ].join('\n'),
  }
}

function createLoop(
  schedule: string,
  intervalMs: number | undefined,
  prompt: string,
): LocalCommandResult {
  const loop: LoopDefinition = {
    id: randomUUID().slice(0, 8),
    schedule,
    intervalMs,
    prompt,
    created: new Date().toISOString(),
  }
  saveLoops([...loadLoops(), loop])
  return {
    type: 'text',
    value: [
      t('Loop recorded: {{id}}', { id: loop.id }),
      t('  schedule: {{schedule}}', { schedule: loop.schedule }),
      t('  prompt:   {{prompt}}', { prompt: loop.prompt }),
      '',
      t(
        'Recording only; scheduler not wired — the record (including the\nparsed interval) is stored in loops.json under the Claude config\nhome, but nothing evaluates or fires it in this build.',
      ),
      t('Delete it: /loops delete {{id}}', { id: loop.id }),
    ].join('\n'),
  }
}

function deleteLoop(id: string): LocalCommandResult {
  const loops = loadLoops()
  const remaining = loops.filter(l => l.id !== id)
  if (remaining.length === loops.length) {
    return { type: 'text', value: t('No loop with id "{{id}}".', { id }) }
  }
  saveLoops(remaining)
  return { type: 'text', value: t('Loop deleted: {{id}}', { id }) }
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseLoopsArgs(rawArgs)
  switch (args.action) {
    case 'list':
      return listLoops()
    case 'create':
      return createLoop(args.schedule, args.intervalMs, args.prompt)
    case 'delete':
      return deleteLoop(args.id)
    case 'help':
      return { type: 'text', value: LOOPS_USAGE }
    case 'invalid':
      return { type: 'text', value: [args.error, '', LOOPS_USAGE].join('\n') }
  }
}
