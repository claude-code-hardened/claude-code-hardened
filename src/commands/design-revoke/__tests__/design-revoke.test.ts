import { describe, expect, test } from 'bun:test'
import { DESIGN_REVOKE_USAGE, parseDesignRevokeArgs } from '../args.js'

describe('parseDesignRevokeArgs — /design-revoke subactions', () => {
  test('bare invocation means revoke', () => {
    expect(parseDesignRevokeArgs('')).toEqual({ action: 'revoke' })
  })

  test('status subaction is non-destructive', () => {
    expect(parseDesignRevokeArgs(' status ')).toEqual({ action: 'status' })
  })

  test('unknown subcommand is invalid with the reason', () => {
    const parsed = parseDesignRevokeArgs('delete')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('delete')
    }
  })

  test('help action exposes the usage text', () => {
    expect(parseDesignRevokeArgs('help')).toEqual({ action: 'help' })
    expect(DESIGN_REVOKE_USAGE).toContain('Revoke')
  })
})
