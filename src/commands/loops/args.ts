/**
 * W3 task #54 — /loops argument parser.
 *
 * Pure module: no I/O, no heavy imports, so tests can load it standalone.
 * Loop schedule uses a simplified interval expression: `@every <n><s|m|h|d>`.
 */

export const SCHEDULE_PATTERN = /^@every\s+(\d+)([smhd])$/

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
}

export type ParsedSchedule =
  | { ok: true; schedule: string; intervalMs: number }
  | { ok: false; error: string }

export function parseSchedule(raw: string): ParsedSchedule {
  const match = SCHEDULE_PATTERN.exec(raw.trim())
  if (!match) {
    return {
      ok: false,
      error:
        'Invalid schedule. Use the simplified interval form: @every <n><s|m|h|d> (e.g. "@every 30m")',
    }
  }
  const intervalMs = Number(match[1]) * UNIT_MS[match[2]]
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { ok: false, error: 'Interval must be a positive duration' }
  }
  return { ok: true, schedule: `@every ${match[1]}${match[2]}`, intervalMs }
}

export type LoopsArgs =
  | { action: 'list' }
  | { action: 'create'; schedule: string; intervalMs: number; prompt: string }
  | { action: 'delete'; id: string }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const LOOPS_USAGE = [
  'Usage: /loops <subcommand>',
  '',
  '  list                                 List saved loops (default)',
  '  create @every <n><s|m|h|d> <prompt>  Create a loop from an interval schedule',
  '  delete <id>                          Delete a loop by id',
  '',
  'Note: loops are recorded to loops.json only — no scheduler is wired in',
  'this build, so saved loops do not fire on their own.',
].join('\n')

export function parseLoopsArgs(raw: string): LoopsArgs {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts[0] === 'list') {
    return { action: 'list' }
  }
  if (parts[0] === 'help') {
    return { action: 'help' }
  }
  if (parts[0] === 'delete') {
    if (parts.length < 2) {
      return { action: 'invalid', error: 'Missing loop id: /loops delete <id>' }
    }
    return { action: 'delete', id: parts[1] }
  }
  if (parts[0] === 'create') {
    // Schedule takes two tokens ("@every" + "<n><unit>"); the prompt is the
    // free-form tail, preserving original spacing.
    if (parts.length < 4) {
      return {
        action: 'invalid',
        error: 'Missing fields: /loops create @every <n><unit> <prompt>',
      }
    }
    const schedule = parseSchedule(`${parts[1]} ${parts[2]}`)
    if (!schedule.ok) {
      return { action: 'invalid', error: schedule.error }
    }
    const headLen = parts[0].length + parts[1].length + parts[2].length + 3
    const prompt = raw.trim().slice(headLen).trim()
    return {
      action: 'create',
      schedule: schedule.schedule,
      intervalMs: schedule.intervalMs,
      prompt,
    }
  }
  return { action: 'invalid', error: `Unknown subcommand: "${parts[0]}"` }
}
