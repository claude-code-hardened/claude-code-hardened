import { afterEach, describe, expect, test } from 'bun:test'
import {
  GRAY_ENV_GATE_NAMES,
  getEnabledGrayGates,
  grayGateEnvVar,
  isGrayGateEnabled,
} from '../grayGates.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('grayGates', () => {
  test('registers the ten official codename gates, default off', () => {
    expect(GRAY_ENV_GATE_NAMES).toHaveLength(10)
    expect(GRAY_ENV_GATE_NAMES[0]).toBe('BASALT_COVE')
    expect(GRAY_ENV_GATE_NAMES[1]).toBe('THRIFTY_SONIC')

    for (const name of GRAY_ENV_GATE_NAMES) {
      delete process.env[`CLAUDE_CODE_${name}`]
      expect(isGrayGateEnabled(name)).toBe(false)
    }
    expect(getEnabledGrayGates()).toEqual([])
  })

  test('explicit truthy env value enables a single gate', () => {
    process.env.CLAUDE_CODE_THRIFTY_SONIC = '1'
    expect(isGrayGateEnabled('THRIFTY_SONIC')).toBe(true)
    expect(getEnabledGrayGates()).toEqual(['THRIFTY_SONIC'])
  })

  test('explicit falsy env value keeps the gate off', () => {
    process.env.CLAUDE_CODE_BASALT_COVE = '0'
    process.env.CLAUDE_CODE_PARCHMENT_FERN = 'false'
    expect(isGrayGateEnabled('BASALT_COVE')).toBe(false)
    expect(isGrayGateEnabled('PARCHMENT_FERN')).toBe(false)
    expect(getEnabledGrayGates()).toEqual([])
  })

  test('grayGateEnvVar maps gate codenames to CLAUDE_CODE_* vars', () => {
    expect(grayGateEnvVar('BASALT_COVE')).toBe('CLAUDE_CODE_BASALT_COVE')
    expect(grayGateEnvVar('BREEZY_HORIZON')).toBe('CLAUDE_CODE_BREEZY_HORIZON')
  })
})
