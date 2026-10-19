import { describe, expect, test } from 'bun:test'
import { LOOPS_USAGE, parseLoopsArgs, parseSchedule } from '../args.js'

describe('parseSchedule — simplified interval expressions', () => {
  test('accepts every supported unit', () => {
    expect(parseSchedule('@every 30s')).toEqual({
      ok: true,
      schedule: '@every 30s',
      intervalMs: 30_000,
    })
    expect(parseSchedule('@every 5m')).toEqual({
      ok: true,
      schedule: '@every 5m',
      intervalMs: 5 * 60_000,
    })
    expect(parseSchedule('@every 2h')).toEqual({
      ok: true,
      schedule: '@every 2h',
      intervalMs: 2 * 3_600_000,
    })
    expect(parseSchedule('@every 1d')).toEqual({
      ok: true,
      schedule: '@every 1d',
      intervalMs: 86_400_000,
    })
  })

  test('rejects unknown units, negative counts and free text', () => {
    expect(parseSchedule('@every 5x').ok).toBe(false)
    expect(parseSchedule('@every -5m').ok).toBe(false)
    expect(parseSchedule('@every').ok).toBe(false)
    expect(parseSchedule('daily').ok).toBe(false)
  })
})

describe('parseLoopsArgs — /loops subactions', () => {
  test('empty args mean list', () => {
    expect(parseLoopsArgs('')).toEqual({ action: 'list' })
    expect(parseLoopsArgs('  list ')).toEqual({ action: 'list' })
  })

  test('create parses schedule and preserves the prompt tail', () => {
    const parsed = parseLoopsArgs('create @every 30m check the CI status')
    expect(parsed).toEqual({
      action: 'create',
      schedule: '@every 30m',
      intervalMs: 30 * 60_000,
      prompt: 'check the CI status',
    })
  })

  test('create with a bad schedule is invalid with a reason', () => {
    const parsed = parseLoopsArgs('create every hour check CI')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('@every')
    }
  })

  test('delete requires an id', () => {
    expect(parseLoopsArgs('delete')).toEqual({
      action: 'invalid',
      error: 'Missing loop id: /loops delete <id>',
    })
    expect(parseLoopsArgs('delete abcd1234')).toEqual({
      action: 'delete',
      id: 'abcd1234',
    })
  })

  test('unknown subcommand is invalid', () => {
    const parsed = parseLoopsArgs('run')
    expect(parsed.action).toBe('invalid')
  })

  test('help action exposes the usage text', () => {
    expect(parseLoopsArgs('help')).toEqual({ action: 'help' })
    expect(LOOPS_USAGE).toContain('create @every')
  })
})
