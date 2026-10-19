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

// Mock log.ts to cut the heavy dependency chain (focus → safeJsonFile → log).
mock.module('src/utils/log.ts', logMock)

import { FOCUS_USAGE, parseFocusArgs } from '../args.js'
import {
  buildFocusSetMessage,
  buildFocusStatusMessage,
  call,
  FOCUS_RENDERER_NOTE,
  getFocusModePath,
  isFocusModeEnabled,
} from '../focus.js'

describe('parseFocusArgs — /focus subactions', () => {
  test('bare invocation means toggle', () => {
    expect(parseFocusArgs('')).toEqual({ action: 'toggle' })
  })

  test('on/off/status are case-insensitive', () => {
    expect(parseFocusArgs('ON')).toEqual({ action: 'on' })
    expect(parseFocusArgs(' Off ')).toEqual({ action: 'off' })
    expect(parseFocusArgs('STATUS')).toEqual({ action: 'status' })
  })

  test('unknown subcommand is invalid with the reason', () => {
    const parsed = parseFocusArgs('zen')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('zen')
    }
  })

  test('help action exposes the usage text', () => {
    expect(parseFocusArgs('help')).toEqual({ action: 'help' })
    expect(FOCUS_USAGE).toContain('focus view')
  })
})

describe('focus copy — honesty about the unwired renderer', () => {
  test('the shared note admits the renderer is not wired', () => {
    expect(FOCUS_RENDERER_NOTE).toContain('not wired in this build')
    expect(FOCUS_RENDERER_NOTE).toContain('preference is stored')
  })

  test('enable message never claims the focus view is active', () => {
    const text = buildFocusSetMessage(true, false)
    expect(text).toContain('preference on')
    expect(text).toContain('would be shown')
    expect(text).toContain('not wired in this build')
    expect(text).not.toContain('Focus view is on:')
  })

  test('already-saved preference is stated, not re-announced as a change', () => {
    expect(buildFocusSetMessage(true, true)).toContain('already set this way')
  })

  test('status message labels the state as a stored preference', () => {
    const text = buildFocusStatusMessage(true)
    expect(text).toContain('(stored preference)')
    expect(text).toContain('not wired in this build')
  })
})

describe('focus persistence — strict store face (W3 round 2)', () => {
  // The copy paths under test never read the context; tests may use as any.
  const ctx = {} as any

  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempHome: string

  const useTempHome = () => {
    tempHome = mkdtempSync(join(tmpdir(), 'focus-store-'))
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

  test('enable/status round-trips through the strict store', async () => {
    useTempHome()
    const on = (await call('on', ctx)) as { type: 'text'; value: string }
    expect(on.value).toContain('preference on')
    expect(isFocusModeEnabled()).toBe(true)
    const status = (await call('status', ctx)) as {
      type: 'text'
      value: string
    }
    expect(status.value).toContain('State:  on')
    // Atomic write left no tmp litter, and the write took the advisory lock
    // which must be released.
    expect(existsSync(`${getFocusModePath()}.lock`)).toBe(false)
    expect(readdirSync(tempHome).some(name => name.includes('.tmp-'))).toBe(
      false,
    )
  })

  test('corrupt store: quarantined to a .corrupt-* backup, reads as an empty table, command still works', async () => {
    useTempHome()
    writeFileSync(getFocusModePath(), '{broken json', 'utf8')
    // Reads surface as "off" (empty table) — the corrupt bytes were moved
    // aside, not silently rewritten.
    expect(isFocusModeEnabled()).toBe(false)
    const backups = existsSync(tempHome)
      ? readdirSync(tempHome)
          .filter(name => name.startsWith('focus-mode.json.corrupt-'))
          .map(name => join(tempHome, name))
      : []
    expect(backups.length).toBe(1)
    // The raw corrupt bytes survive at the quarantine path.
    expect(readFileSync(backups[0]!, 'utf8')).toBe('{broken json')
    // The command surface still works and reports the honest "off" face.
    const status = (await call('status', ctx)) as {
      type: 'text'
      value: string
    }
    expect(status.value).toContain('State:  off')
    const on = (await call('on', ctx)) as { type: 'text'; value: string }
    expect(on.value).toContain('preference on')
  })

  test('toggle decides the new value inside the lock (no lost read)', async () => {
    useTempHome()
    const first = (await call('', ctx)) as { type: 'text'; value: string }
    expect(first.value).toContain('preference on')
    const second = (await call('', ctx)) as { type: 'text'; value: string }
    expect(second.value).toContain('preference off')
    expect(isFocusModeEnabled()).toBe(false)
  })
})
