import { describe, expect, test } from 'bun:test'
import { FOCUS_USAGE, parseFocusArgs } from '../args.js'
import {
  buildFocusSetMessage,
  buildFocusStatusMessage,
  FOCUS_RENDERER_NOTE,
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
