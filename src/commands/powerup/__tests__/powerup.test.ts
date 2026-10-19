import { describe, expect, test } from 'bun:test'
import { POWERUP_USAGE, parsePowerupArgs } from '../args.js'
import { formatPowerupCourse, POWERUP_COURSE } from '../powerup.js'

describe('parsePowerupArgs — /powerup arguments', () => {
  test('bare invocation shows the course checklist', () => {
    expect(parsePowerupArgs('')).toEqual({ action: 'show' })
    expect(parsePowerupArgs(' show ')).toEqual({ action: 'show' })
  })

  test('help action exposes the usage text', () => {
    expect(parsePowerupArgs('help')).toEqual({ action: 'help' })
    expect(POWERUP_USAGE).toContain('course checklist')
    expect(POWERUP_USAGE).toContain('no balance to claim or spend')
  })

  test('claim/list balance semantics are gone (any other arg is invalid)', () => {
    for (const raw of ['claim', 'claim 5', 'list', 'drink']) {
      expect(parsePowerupArgs(raw).action).toBe('invalid')
    }
    expect(POWERUP_USAGE).not.toContain('claim <n>')
  })
})

describe('formatPowerupCourse — static checklist content', () => {
  test('renders numbered steps in order', () => {
    const text = formatPowerupCourse()
    expect(POWERUP_COURSE.length).toBeGreaterThanOrEqual(5)
    expect(text).toContain('1. Orient the model')
    expect(text).toContain('step by step')
  })

  test('is honest: static, no counters, nothing to claim', () => {
    const text = formatPowerupCourse()
    expect(text).toContain('Static checklist')
    expect(text).toContain('no balance')
    expect(text).not.toContain('Balance:')
    expect(text).not.toContain('Claimed:')
  })
})
