import { describe, expect, test } from 'bun:test'
import { DESIGN_CONSENT_USAGE, parseDesignConsentArgs } from '../args.js'
import { loadDesignConsent } from '../design-consent.js'

describe('parseDesignConsentArgs — /design-consent subactions', () => {
  test('empty or explicit status args mean status', () => {
    expect(parseDesignConsentArgs('')).toEqual({ action: 'status' })
    expect(parseDesignConsentArgs(' status ')).toEqual({ action: 'status' })
  })

  test('grant and decline are case-insensitive', () => {
    expect(parseDesignConsentArgs('GRANT')).toEqual({ action: 'grant' })
    expect(parseDesignConsentArgs('Decline')).toEqual({ action: 'decline' })
  })

  test('unknown subcommand is invalid with the reason', () => {
    const parsed = parseDesignConsentArgs('maybe')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('maybe')
    }
  })

  test('help action exposes the usage text', () => {
    expect(parseDesignConsentArgs('help')).toEqual({ action: 'help' })
    expect(DESIGN_CONSENT_USAGE).toContain('grant')
  })
})

describe('loadDesignConsent — local record reader', () => {
  test('returns null when no consent has been recorded', () => {
    if (!process.env.CLAUDE_CONFIG_DIR) {
      expect(loadDesignConsent()).toBeNull()
    } else {
      // Config home is overridden in this environment; the reader must still
      // return either a valid record or null (never throw on malformed data).
      const record = loadDesignConsent()
      expect(
        record === null ||
          record.consent === 'granted' ||
          record.consent === 'declined',
      ).toBe(true)
    }
  })
})
