/** W4 (#55) — tests for the sandbox decision telemetry seam (structure-first). */
import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const {
  recordSandboxDecision,
  getRecentSandboxDecisions,
  resetSandboxDecisionTelemetry,
} = await import('../telemetry.js')

describe('sandbox decision telemetry (W4)', () => {
  test('records a decision with minimal fields', () => {
    resetSandboxDecisionTelemetry()
    const decision = { requiresConfiningSandbox: true, masked: true }
    recordSandboxDecision(decision)
    expect(getRecentSandboxDecisions()).toEqual([decision])
  })

  test('records full attribution context', () => {
    resetSandboxDecisionTelemetry()
    recordSandboxDecision({
      attributionId: 'att_1',
      masked: false,
      denyRead: true,
      denyWrite: false,
      requiresConfiningSandbox: true,
    })
    const recent = [...getRecentSandboxDecisions()]
    expect(recent.at(-1)).toMatchObject({
      attributionId: 'att_1',
      denyRead: true,
      requiresConfiningSandbox: true,
    })
  })

  test('buffer is bounded and drops oldest entries', () => {
    resetSandboxDecisionTelemetry()
    for (let i = 0; i < 110; i++) {
      recordSandboxDecision({ requiresConfiningSandbox: i % 2 === 0 })
    }
    const recent = getRecentSandboxDecisions()
    expect(recent.length).toBe(100)
    // The first 10 decisions were dropped: the oldest remaining is i=10 (even).
    expect(recent[0]?.requiresConfiningSandbox).toBe(true)
    expect(recent.at(-1)?.requiresConfiningSandbox).toBe(false)
  })

  test('reset clears the buffer', () => {
    recordSandboxDecision({ requiresConfiningSandbox: true })
    resetSandboxDecisionTelemetry()
    expect(getRecentSandboxDecisions()).toHaveLength(0)
  })
})
