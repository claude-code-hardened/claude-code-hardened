import { describe, expect, test } from 'bun:test'
import { USAGE_LINK, parseUsageCreditsArgs } from '../args.js'
import { formatAdminRequestCopy, formatUsageSummary } from '../usage-credits.js'

// formatUsageSummary/formatAdminRequestCopy only read bootstrap state getters
// (no import-time side effects beyond bootstrap/state itself, which other
// tests import directly), so the formatting surface is tested via plain
// static imports.

describe('parseUsageCreditsArgs — /usage-credits argument surface', () => {
  test('no args means show', () => {
    expect(parseUsageCreditsArgs('')).toEqual({ action: 'show' })
  })

  test('request subaction', () => {
    expect(parseUsageCreditsArgs('request')).toEqual({ action: 'request' })
    expect(parseUsageCreditsArgs('  REQUEST ')).toEqual({ action: 'request' })
  })

  test('help and unknown subcommands', () => {
    expect(parseUsageCreditsArgs('help')).toEqual({ action: 'help' })
    expect(parseUsageCreditsArgs('buy').action).toBe('invalid')
  })
})

describe('usage-credits copy', () => {
  test('summary includes the usage link and token lines', () => {
    const text = formatUsageSummary()
    expect(text).toContain('Usage summary')
    expect(text).toContain(USAGE_LINK)
  })

  test('admin request template is copy-pasteable', () => {
    const text = formatAdminRequestCopy()
    expect(text).toContain('usage credits request')
    expect(text).toContain(USAGE_LINK)
  })
})
