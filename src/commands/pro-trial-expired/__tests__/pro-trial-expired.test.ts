import { describe, expect, test } from 'bun:test'
import { PRO_TRIAL_EXPIRED_USAGE, parseProTrialExpiredArgs } from '../args.js'
import { formatProTrialExpiredCopy } from '../pro-trial-expired.js'
import proTrialExpired from '../index.js'

describe('pro-trial-expired command definition — hidden notice surface', () => {
  test('is hidden from menus per official isHidden semantics', () => {
    expect(proTrialExpired.isHidden).toBe(true)
  })

  test('stays scoped to the claude.ai subscriber account', () => {
    expect(proTrialExpired.availability).toEqual(['claude-ai'])
  })

  test('remains invocable (hidden, not disabled)', () => {
    expect(proTrialExpired.type).toBe('local')
    expect(typeof proTrialExpired.load).toBe('function')
  })
})

describe('parseProTrialExpiredArgs — /pro-trial-expired arguments', () => {
  test('bare invocation and "show" both show the notice', () => {
    expect(parseProTrialExpiredArgs('')).toEqual({ action: 'show' })
    expect(parseProTrialExpiredArgs(' show ')).toEqual({ action: 'show' })
  })

  test('any argument is invalid (the command takes none)', () => {
    const parsed = parseProTrialExpiredArgs('upgrade')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('upgrade')
    }
  })

  test('help action exposes the usage text', () => {
    expect(parseProTrialExpiredArgs('help')).toEqual({ action: 'help' })
    expect(PRO_TRIAL_EXPIRED_USAGE).toContain('Takes no arguments')
  })
})

describe('formatProTrialExpiredCopy — notice content', () => {
  test('mentions the upgrade path and usage link', () => {
    const text = formatProTrialExpiredCopy()
    expect(text).toContain('trial has ended')
    expect(text).toContain('/upgrade')
    expect(text).toContain('/login')
  })
})
