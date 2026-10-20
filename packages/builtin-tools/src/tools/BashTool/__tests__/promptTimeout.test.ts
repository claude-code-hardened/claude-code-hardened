import { afterEach, describe, expect, test } from 'bun:test'
import {
  clampTimeoutMs,
  getDefaultTimeoutMs,
  getMaxTimeoutMs,
} from '../prompt.js'

describe('clampTimeoutMs', () => {
  const savedDefault = process.env.BASH_DEFAULT_TIMEOUT_MS
  const savedMax = process.env.BASH_MAX_TIMEOUT_MS

  afterEach(() => {
    if (savedDefault === undefined) {
      delete process.env.BASH_DEFAULT_TIMEOUT_MS
    } else {
      process.env.BASH_DEFAULT_TIMEOUT_MS = savedDefault
    }
    if (savedMax === undefined) {
      delete process.env.BASH_MAX_TIMEOUT_MS
    } else {
      process.env.BASH_MAX_TIMEOUT_MS = savedMax
    }
  })

  function cleanEnv(): void {
    delete process.env.BASH_DEFAULT_TIMEOUT_MS
    delete process.env.BASH_MAX_TIMEOUT_MS
  }

  test('undefined timeout falls back to the default', () => {
    cleanEnv()
    expect(clampTimeoutMs(undefined)).toBe(getDefaultTimeoutMs())
    expect(getDefaultTimeoutMs()).toBe(120_000)
  })

  test('zero timeout falls back to the default (falsy, not 0ms)', () => {
    cleanEnv()
    expect(clampTimeoutMs(0)).toBe(getDefaultTimeoutMs())
  })

  test('negative timeout falls back to the default (not passed through)', () => {
    cleanEnv()
    expect(clampTimeoutMs(-1)).toBe(getDefaultTimeoutMs())
    expect(clampTimeoutMs(-600_000)).toBe(getDefaultTimeoutMs())
  })

  test('value within range passes through unchanged', () => {
    cleanEnv()
    expect(clampTimeoutMs(5_000)).toBe(5_000)
    expect(clampTimeoutMs(600_000)).toBe(600_000)
  })

  test('value above the max is clamped to the max', () => {
    cleanEnv()
    expect(clampTimeoutMs(600_001)).toBe(getMaxTimeoutMs())
    expect(clampTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(getMaxTimeoutMs())
  })

  test('respects BASH_MAX_TIMEOUT_MS env override for the clamp ceiling', () => {
    cleanEnv()
    process.env.BASH_MAX_TIMEOUT_MS = '1000'
    expect(clampTimeoutMs(5_000)).toBe(1000)
    expect(clampTimeoutMs(1000)).toBe(1000)
  })

  test('explicit timeout below the default is NOT lifted (official upper-bound semantics)', () => {
    cleanEnv()
    // Official `Rxo` (reverse-284 _ALL.js:7381):
    // `Math.min(typeof o === "number" && o > 0 ? o : default, max)` —
    // BASH_DEFAULT_TIMEOUT_MS is only the fallback for 0/absent values, never
    // a floor. A deliberate short probe timeout (2s) must not be dragged to
    // the default (120s) by an env default.
    process.env.BASH_DEFAULT_TIMEOUT_MS = '120000'
    expect(clampTimeoutMs(2_000)).toBe(2_000)
    expect(clampTimeoutMs(5_000)).toBe(5_000)
    expect(clampTimeoutMs(undefined)).toBe(120_000)
  })

  test('BASH_DEFAULT_TIMEOUT_MS env override changes the fallback', () => {
    cleanEnv()
    process.env.BASH_DEFAULT_TIMEOUT_MS = '45000'
    expect(clampTimeoutMs(0)).toBe(45_000)
    expect(clampTimeoutMs(-5)).toBe(45_000)
    expect(clampTimeoutMs(undefined)).toBe(45_000)
  })
})
