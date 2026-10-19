import { describe, expect, test, mock, afterEach } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logMock } from '../../../../tests/mocks/log'

// Mock log.ts to cut the heavy dependency chain
// (auto-mode-setup → safeJsonFile → log).
mock.module('src/utils/log.ts', logMock)

import { AUTO_MODE_SETUP_USAGE, parseAutoModeSetupArgs } from '../args.js'
import {
  call,
  getAutoModeSetupPath,
  loadAutoModeSetup,
} from '../auto-mode-setup.js'

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

describe('auto-mode-setup strict store face (W3 round 2)', () => {
  // The copy paths under test never read the context; tests may use as any.
  const ctx = {} as any

  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempHome: string

  const useTempHome = () => {
    tempHome = mkdtempSync(join(tmpdir(), 'automode-store-'))
    process.env.CLAUDE_CONFIG_DIR = tempHome
  }

  afterEach(() => {
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true })
      tempHome = undefined as unknown as string
    }
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  test('enable → loadAutoModeSetup rounds-trips the marker', async () => {
    useTempHome()
    await call('enable', ctx)
    expect(loadAutoModeSetup()?.enabled).toBe(true)
    // The advisory lock was taken and released; no tmp litter.
    expect(existsSync(`${getAutoModeSetupPath()}.lock`)).toBe(false)
    expect(readdirSync(tempHome).some(name => name.includes('.tmp-'))).toBe(
      false,
    )
  })

  test('corrupt marker: quarantined to a .corrupt-* backup and reads as not set up', async () => {
    useTempHome()
    writeFileSync(getAutoModeSetupPath(), 'not-json{{', 'utf8')
    expect(loadAutoModeSetup()).toBeNull()
    const backups = readdirSync(tempHome)
      .filter(name => name.startsWith('auto-mode-setup.json.corrupt-'))
      .map(name => join(tempHome, name))
    expect(backups).toHaveLength(1)
    expect(readFileSync(backups[0]!, 'utf8')).toBe('not-json{{')
    // The command status face reports the honest "not set up" table.
    const record = (await call('status', ctx)) as {
      type: 'text'
      value: string
    }
    expect(record.value).toContain('not set up')
  })

  test('shape-refused marker (valid JSON, wrong shape) is quarantined too', async () => {
    useTempHome()
    writeFileSync(getAutoModeSetupPath(), '{"enabled":"yes"}', 'utf8')
    expect(loadAutoModeSetup()).toBeNull()
    const backups = readdirSync(tempHome).filter(name =>
      name.startsWith('auto-mode-setup.json.corrupt-'),
    )
    expect(backups).toHaveLength(1)
  })

  test('disable is a locked read-modify-write and clears the marker', async () => {
    useTempHome()
    await call('enable', ctx)
    await call('disable', ctx)
    expect(loadAutoModeSetup()?.enabled).toBe(false)
    expect(existsSync(`${getAutoModeSetupPath()}.lock`)).toBe(false)
  })
})
