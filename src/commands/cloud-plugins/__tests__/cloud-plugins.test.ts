import { describe, expect, test } from 'bun:test'
import { CLOUD_PLUGINS_USAGE, parseCloudPluginsArgs } from '../args.js'

describe('parseCloudPluginsArgs — /cloud-plugins subactions', () => {
  test('bare invocation means toggle', () => {
    expect(parseCloudPluginsArgs('')).toEqual({ action: 'toggle' })
  })

  test('on/off/status are case-insensitive', () => {
    expect(parseCloudPluginsArgs('ON')).toEqual({ action: 'on' })
    expect(parseCloudPluginsArgs(' Off ')).toEqual({ action: 'off' })
    expect(parseCloudPluginsArgs('STATUS')).toEqual({ action: 'status' })
  })

  test('unknown subcommand is invalid with the reason', () => {
    const parsed = parseCloudPluginsArgs('sync')
    expect(parsed.action).toBe('invalid')
    if (parsed.action === 'invalid') {
      expect(parsed.error).toContain('sync')
    }
  })

  test('help action exposes the usage text', () => {
    expect(parseCloudPluginsArgs('help')).toEqual({ action: 'help' })
    expect(CLOUD_PLUGINS_USAGE).toContain('/cloud-plugins')
  })
})
