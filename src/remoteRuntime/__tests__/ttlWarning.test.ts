import { describe, expect, test } from 'bun:test'
import {
  TTL_WARNING_THRESHOLD_RATIO,
  computeTokenRefreshTtlWarning,
} from '../ttlWarning.js'

describe('computeTokenRefreshTtlWarning', () => {
  test('returns null below the 80% refresh point', () => {
    // TTL 1200s; 50% since last refresh = 600_000ms — well below 80%.
    expect(computeTokenRefreshTtlWarning(1200, 600_000)).toBeNull()
    // Just under the point: 79.9% of 1000s.
    expect(computeTokenRefreshTtlWarning(1000, 799_000)).toBeNull()
  })

  test('returns null for degenerate inputs', () => {
    expect(computeTokenRefreshTtlWarning(0, 0)).toBeNull()
    expect(computeTokenRefreshTtlWarning(-10, 500)).toBeNull()
    expect(computeTokenRefreshTtlWarning(Number.NaN, 500)).toBeNull()
    expect(computeTokenRefreshTtlWarning(600, Number.NaN)).toBeNull()
    expect(computeTokenRefreshTtlWarning(600, -1)).toBeNull()
    expect(
      computeTokenRefreshTtlWarning(Number.POSITIVE_INFINITY, 0),
    ).toBeNull()
  })

  test('fires at exactly the 80% point of the token refresh schedule', () => {
    const ttlSec = 1000
    const atThreshold = ttlSec * 1000 * TTL_WARNING_THRESHOLD_RATIO
    const warning = computeTokenRefreshTtlWarning(ttlSec, atThreshold)
    expect(warning).not.toBeNull()
    expect(warning).toContain('80%-TTL')
    expect(warning).toContain('refresh')
    expect(warning).toContain('clock skew')
    expect(warning).toContain('left')
  })

  test('warning stays inside the last 20% window and carries TTL numbers', () => {
    // 90% of a 3600s TTL: 360s of token left.
    const warning = computeTokenRefreshTtlWarning(3600, 0.9 * 3600 * 1000)
    expect(warning).not.toBeNull()
    expect(warning).toContain('3600s')
    expect(warning).toContain('360s')
  })

  test('zero elapsed time since a refresh stays below the threshold', () => {
    expect(computeTokenRefreshTtlWarning(600, 0)).toBeNull()
  })

  test('escalates once the refresh window is missed (past 100% of TTL)', () => {
    const warning = computeTokenRefreshTtlWarning(600, 2 * 600 * 1000)
    expect(warning).not.toBeNull()
    expect(warning).toContain('missed')
    expect(warning).toContain('refresh')
    expect(warning).toContain('NTP')
  })

  test('caps the reported percentage at 100', () => {
    const warning = computeTokenRefreshTtlWarning(60, 10 * 60 * 1000)
    expect(warning).not.toBeNull()
    expect(warning).toContain('100%')
  })
})
