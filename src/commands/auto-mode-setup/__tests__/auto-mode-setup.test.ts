import { describe, expect, test } from 'bun:test'
import { AUTO_MODE_SETUP_USAGE, parseAutoModeSetupArgs } from '../args.js'

describe('parseAutoModeSetupArgs — /auto-mode-setup subactions', () => {
  test('empty or explicit status args mean status', () => {
    expect(parseAutoModeSetupArgs('')).toEqual({ action: 'status' })
    expect(parseAutoModeSetupArgs('  STATUS ')).toEqual({ action: 'status' })
  })

  test('enable and disable are case-insensitive', () => {
    expect(parseAutoModeSetupArgs('enable')).toEqual({ action: 'enable' })
    expect(parseAutoModeSetupArgs(' Disable ')).toEqual({ action: 'disable' })
  })

  test('unknown subcommand is invalid with the reason', () => {
    const parsed = parseAutoModeSetupArgs('nomode')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('nomode')
    }
  })

  test('a second positional token is invalid', () => {
    expect(parseAutoModeSetupArgs('enable disable').action).toBe('invalid')
  })

  test('help action exposes the usage text', () => {
    expect(parseAutoModeSetupArgs('help')).toEqual({ action: 'help' })
    expect(AUTO_MODE_SETUP_USAGE).toContain('enable')
    expect(AUTO_MODE_SETUP_USAGE).toContain('not supported in')
  })
})

describe('parseAutoModeSetupArgs — official parameter surface', () => {
  test('bare --propose is recognized as unsupported', () => {
    expect(parseAutoModeSetupArgs('--propose')).toEqual({
      action: 'unsupported',
      flags: ['--propose'],
    })
  })

  test('--request-id takes an inline or spaced value', () => {
    expect(parseAutoModeSetupArgs('--request-id=req_123')).toEqual({
      action: 'unsupported',
      flags: ['--request-id <id>'],
    })
    expect(parseAutoModeSetupArgs('--request-id req_123')).toEqual({
      action: 'unsupported',
      flags: ['--request-id <id>'],
    })
  })

  test('--wizard requires a posture= token', () => {
    expect(parseAutoModeSetupArgs('--wizard posture=always')).toEqual({
      action: 'unsupported',
      flags: ['--wizard posture=<posture>'],
    })
    expect(parseAutoModeSetupArgs('--wizard').action).toBe('invalid')
    expect(parseAutoModeSetupArgs('--wizard vibe=always').action).toBe(
      'invalid',
    )
  })

  test('--expect-sha256 and --apply-file are recognized', () => {
    const parsed = parseAutoModeSetupArgs(
      '--expect-sha256=abc123 --apply-file /tmp/proposal.json',
    )
    expect(parsed.action).toBe('unsupported')
    if (parsed.action === 'unsupported') {
      expect(parsed.flags).toEqual([
        '--expect-sha256 <sha256>',
        '--apply-file <path>',
      ])
    }
  })

  test('value flags without a value are invalid', () => {
    expect(parseAutoModeSetupArgs('--request-id').action).toBe('invalid')
    expect(parseAutoModeSetupArgs('--expect-sha256=').action).toBe('invalid')
    expect(parseAutoModeSetupArgs('--apply-file').action).toBe('invalid')
  })

  test('unknown options are invalid', () => {
    const parsed = parseAutoModeSetupArgs('--bogus x')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('--bogus')
    }
  })

  test('flags never smuggle an execution: positional + flag is unsupported', () => {
    // The command must not write the enabled marker when unsupported flags
    // are present — parse-only, honestly declined.
    expect(parseAutoModeSetupArgs('enable --propose')).toEqual({
      action: 'unsupported',
      flags: ['--propose'],
    })
  })
})
