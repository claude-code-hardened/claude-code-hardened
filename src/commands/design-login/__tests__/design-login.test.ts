import { describe, expect, test } from 'bun:test'
import { DESIGN_LOGIN_USAGE, parseDesignLoginArgs } from '../args.js'
import { formatDesignLoginStatus } from '../design-login.js'

describe('parseDesignLoginArgs — /design-login subactions', () => {
  test('empty or explicit status args mean status', () => {
    expect(parseDesignLoginArgs('')).toEqual({ action: 'status' })
    expect(parseDesignLoginArgs(' Status ')).toEqual({ action: 'status' })
  })

  test('connect subaction', () => {
    expect(parseDesignLoginArgs('connect')).toEqual({ action: 'connect' })
    expect(parseDesignLoginArgs('  CONNECT ')).toEqual({ action: 'connect' })
  })

  test('unknown subcommand is invalid with the reason', () => {
    const parsed = parseDesignLoginArgs('oauth')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('oauth')
    }
  })

  test('help action exposes the usage text', () => {
    expect(parseDesignLoginArgs('help')).toEqual({ action: 'help' })
    expect(DESIGN_LOGIN_USAGE).toContain('connect')
  })
})

describe('formatDesignLoginStatus — status surface', () => {
  test('reports the connection state and record path', () => {
    const text = formatDesignLoginStatus()
    expect(text).toContain('Design session')
    expect(text).toContain('design-session.json')
  })
})
